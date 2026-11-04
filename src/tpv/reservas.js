// Reservas del TPV: un cliente aparta productos sin pagar, como mucho
// TPV_RESERVA_DIAS días (7 por defecto). Lo reservado no sale del stock
// físico: resta de lo disponible para vender mientras la reserva está activa
// y no ha vencido, así que al vencer se libera sola aunque nadie la toque.
// `caducarReservas` (idempotente) la marca «caducada» y borra los datos de
// contacto de las cerradas hace más de 30 días. Del cliente solo se pide un
// nombre y, si quiere, un teléfono para avisarle.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';

export const ESTADOS_RESERVA = Object.freeze({ activa: 'Activa', vendida: 'Vendida', cancelada: 'Anulada', caducada: 'Caducada' });
const FILTROS = Object.freeze({
  activas: { where: "r.status = 'activa'", orden: 'r.expires_at ASC, r.id ASC' },
  cerradas: { where: "r.status <> 'activa'", orden: 'r.closed_at DESC, r.id DESC' },
  todas: { where: 'TRUE', orden: "(r.status = 'activa') DESC, r.expires_at DESC, r.id DESC" },
});
const MAX_LINEAS = 20;
const MAX_CANTIDAD = 10;
const MAX_LISTA = 200;
const RETENCION_CONTACTO_DIAS = 30;
const TZ = 'Atlantic/Canary';

const noValida = (msg) => new HttpError(400, `Reserva no válida: ${msg}.`, 'INVALID_RESERVATION');
const limpio = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const descripcion = (a) => [a.brand, a.model !== a.reference ? a.model : null, a.reference, a.color].filter(Boolean).join(' · ');
const conTalla = (a) => `${descripcion(a)}${a.size && a.size !== 'Única' ? ` T. ${a.size}` : ''}`;

/** Unidades reservadas (activas y sin vencer) de cada artículo. `excepto` = una reserva que no cuenta. */
export async function reservadoPorArticulo(db, ids, { excepto = null } = {}) {
  if (!ids.length) return new Map();
  const rows = (await db.query(
    `SELECT l.item_id, sum(l.quantity)::int AS n FROM tpv_reservation_lines l JOIN tpv_reservations r ON r.id = l.reservation_id
      WHERE l.item_id = ANY($1) AND r.status = 'activa' AND r.expires_at > NOW() AND r.id IS DISTINCT FROM $2
      GROUP BY l.item_id`, [ids, excepto],
  )).rows;
  return new Map(rows.map((r) => [r.item_id, r.n]));
}

/**
 * Dentro de la transacción de una venta (con los artículos ya bloqueados):
 * lo reservado para otro cliente no se vende. Si el sistema dice que no hay
 * stock y no hay reservas, se vende igual (el zapato está en la mano).
 */
export async function comprobarNoReservado(client, lineas, stock) {
  const pedido = new Map();
  for (const l of lineas) if (l.articulo_id) pedido.set(l.articulo_id, (pedido.get(l.articulo_id) ?? 0) + l.cantidad);
  const reservado = await reservadoPorArticulo(client, [...pedido.keys()]);
  for (const [id, cantidad] of pedido) {
    const n = reservado.get(id) ?? 0;
    const fisico = stock.get(id) ?? 0;
    if (!n || fisico - n >= cantidad) continue;
    const r = (await client.query(
      `SELECT r.customer_name, a.brand, a.model, a.reference, a.color, a.size,
              to_char((r.expires_at AT TIME ZONE '${TZ}') - interval '1 second', 'DD/MM') AS hasta
         FROM tpv_reservation_lines l JOIN tpv_reservations r ON r.id = l.reservation_id JOIN inventory_items a ON a.id = l.item_id
        WHERE l.item_id = $1 AND r.status = 'activa' AND r.expires_at > NOW() ORDER BY r.expires_at LIMIT 1`, [id],
    )).rows[0];
    const libres = Math.max(fisico - n, 0);
    throw new HttpError(409,
      `«${conTalla(r)}» está reservado para ${r.customer_name} hasta el ${r.hasta}${libres ? ` (solo ${libres} sin reservar)` : ''}. `
      + 'Si es su compra, véndelo desde Reservas; si no, anula la reserva primero.', 'RESERVED');
  }
}

function leerTelefono(v) {
  const t = String(v ?? '').replace(/[\s().-]/g, '');
  if (!t) return null;
  if (!/^\+?\d{9,15}$/.test(t)) throw noValida('el teléfono tiene que tener entre 9 y 15 cifras');
  return t;
}

function leerDias(v, diasMax) {
  if (v == null || v === '') return diasMax;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > diasMax) throw noValida(`como mucho ${diasMax} ${diasMax === 1 ? 'día' : 'días'}`);
  return n;
}

function leerLineas(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) throw noValida('no tiene productos');
  if (lineas.length > MAX_LINEAS) throw noValida(`como mucho ${MAX_LINEAS} productos`);
  const juntas = new Map();
  for (const l of lineas) {
    const id = Number(l?.articulo_id);
    const cantidad = Number(l?.cantidad ?? 1);
    if (!Number.isInteger(id) || id <= 0) throw noValida('solo se reservan productos del stock');
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) throw noValida(`la cantidad va de 1 a ${MAX_CANTIDAD}`);
    juntas.set(id, (juntas.get(id) ?? 0) + cantidad);
  }
  if ([...juntas.values()].some((n) => n > MAX_CANTIDAD)) throw noValida(`como mucho ${MAX_CANTIDAD} unidades de cada producto`);
  return juntas;
}

/** Bloquea los artículos (en orden) y comprueba que hay unidades libres para apartar. */
async function apartar(client, juntas, { excepto = null } = {}) {
  const ids = [...juntas.keys()].sort((a, b) => a - b);
  const items = new Map((await client.query('SELECT * FROM inventory_items WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids])).rows.map((r) => [r.id, r]));
  if (items.size !== ids.length) throw noValida('algún producto ya no existe');
  const reservado = await reservadoPorArticulo(client, ids, { excepto });
  for (const [id, cantidad] of juntas) {
    const a = items.get(id);
    const libres = Math.max(a.stock - (reservado.get(id) ?? 0), 0);
    if (cantidad > libres) {
      throw new HttpError(409, libres
        ? `De «${conTalla(a)}» solo ${libres === 1 ? 'queda 1 unidad libre' : `quedan ${libres} unidades libres`}.`
        : `No hay «${conTalla(a)}» libre para reservar (sin stock o ya reservado).`, 'NOT_AVAILABLE');
    }
  }
  return items;
}

/** Fin (exclusivo) de la reserva: medianoche en Canarias tras el último día. */
const VENCE_SQL = `((((NOW() AT TIME ZONE '${TZ}')::date + $1::int + 1)::timestamp) AT TIME ZONE '${TZ}')`;

export async function crearReserva(pool, { datos, usuario, diasMax }) {
  const nombre = limpio(datos?.nombre, 60);
  if (nombre.length < 2) throw noValida('escribe el nombre del cliente (basta con el nombre de pila)');
  const telefono = leerTelefono(datos?.telefono);
  const notas = limpio(datos?.notas, 200);
  const dias = leerDias(datos?.dias, diasMax);
  const juntas = leerLineas(datos?.lineas);
  return withTransaction(pool, async (client) => {
    await apartar(client, juntas);
    const r = (await client.query(
      `INSERT INTO tpv_reservations (customer_name, phone, notes, expires_at, created_by) VALUES ($2, $3, $4, ${VENCE_SQL}, $5) RETURNING id`,
      [dias, nombre, telefono, notas, usuario.id],
    )).rows[0];
    for (const [id, cantidad] of juntas) {
      await client.query('INSERT INTO tpv_reservation_lines (reservation_id, item_id, quantity) VALUES ($1, $2, $3)', [r.id, id, cantidad]);
    }
    return r.id;
  });
}

const SELECT = `
  SELECT r.*, uc.name AS por, ux.name AS cerro, t.number AS ticket,
         to_char(r.created_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS creada,
         to_char(r.closed_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS cerrada,
         to_char((r.expires_at AT TIME ZONE '${TZ}') - interval '1 second', 'YYYY-MM-DD') AS ultimo,
         (((r.expires_at AT TIME ZONE '${TZ}') - interval '1 second')::date - (NOW() AT TIME ZONE '${TZ}')::date)::int AS dias_restantes
    FROM tpv_reservations r
    LEFT JOIN users uc ON uc.id = r.created_by
    LEFT JOIN users ux ON ux.id = r.closed_by
    LEFT JOIN tpv_tickets t ON t.id = r.ticket_id`;

async function conLineas(db, rows) {
  if (!rows.length) return [];
  const lineas = (await db.query(
    `SELECT l.reservation_id, l.quantity, a.* FROM tpv_reservation_lines l JOIN inventory_items a ON a.id = l.item_id
      WHERE l.reservation_id = ANY($1) ORDER BY l.id`, [rows.map((r) => r.id)],
  )).rows;
  return rows.map((r) => {
    const mias = lineas.filter((l) => l.reservation_id === r.id).map((a) => ({
      articulo_id: a.id, descripcion: descripcion(a), marca: a.brand, modelo: a.model, referencia: a.reference, color: a.color,
      talla: a.size, codigo: a.barcode, tipo: a.type, cantidad: a.quantity, pvp_cent: a.sale_price_cents, stock: a.stock,
    }));
    const vencida = r.status === 'activa' && r.dias_restantes < 0;
    return {
      id: r.id, estado: vencida ? 'caducada' : r.status, nombre: r.customer_name, telefono: r.phone, notas: r.notes,
      creada: r.creada, por: r.por, hasta: r.ultimo, dias_restantes: r.dias_restantes, prorrogas: r.extensions,
      cerrada: r.cerrada, cerro: r.cerro, motivo: r.cancel_reason, ticket: r.ticket, datos_borrados: r.contact_erased,
      lineas: mias,
      unidades: mias.reduce((s, l) => s + l.cantidad, 0),
      total_cent: mias.every((l) => l.pvp_cent != null) ? mias.reduce((s, l) => s + l.cantidad * l.pvp_cent, 0) : null,
    };
  });
}

export async function obtenerReserva(db, id) {
  const r = (await db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Esa reserva no existe.', 'NOT_FOUND');
  return (await conLineas(db, [r]))[0];
}

export async function resumenReservas(db) {
  const r = (await db.query(
    `SELECT count(*)::int AS activas,
            count(*) FILTER (WHERE ((expires_at AT TIME ZONE '${TZ}') - interval '1 second')::date <= (NOW() AT TIME ZONE '${TZ}')::date)::int AS vencen_hoy,
            count(*) FILTER (WHERE ((expires_at AT TIME ZONE '${TZ}') - interval '1 second')::date = (NOW() AT TIME ZONE '${TZ}')::date + 1)::int AS vencen_manana
       FROM tpv_reservations WHERE status = 'activa' AND expires_at > NOW()`,
  )).rows[0];
  return r;
}

export async function listarReservas(db, { estado = 'activas' } = {}) {
  const f = Object.hasOwn(FILTROS, estado) ? FILTROS[estado] : null;
  if (!f) throw new HttpError(400, 'Filtro no válido.', 'INVALID_FILTER');
  const rows = (await db.query(`${SELECT} WHERE ${f.where} ORDER BY ${f.orden} LIMIT ${MAX_LISTA}`)).rows;
  return { items: await conLineas(db, rows), totales: await resumenReservas(db) };
}

async function bloquear(client, id) {
  const r = (await client.query('SELECT * FROM tpv_reservations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Esa reserva no existe.', 'NOT_FOUND');
  return r;
}

const yaCerrada = (r) => new HttpError(409, `Esa reserva ya está ${ESTADOS_RESERVA[r.status].toLowerCase()}.`, 'RESERVATION_CLOSED');

export async function cancelarReserva(pool, id, { motivo, usuario }) {
  return withTransaction(pool, async (client) => {
    const r = await bloquear(client, id);
    if (r.status !== 'activa') throw yaCerrada(r);
    await client.query(
      "UPDATE tpv_reservations SET status = 'cancelada', closed_at = NOW(), closed_by = $2, cancel_reason = $3 WHERE id = $1",
      [id, usuario.id, limpio(motivo, 120) || null],
    );
    return r;
  });
}

/**
 * Prórroga (la da un Administrador): hasta `dias` días desde hoy, si las unidades
 * siguen libres. También reactiva una caducada (si aún tiene los datos del cliente).
 */
export async function prorrogarReserva(pool, id, { dias, usuario, diasMax }) {
  const n = leerDias(dias, diasMax);
  return withTransaction(pool, async (client) => {
    const r = await bloquear(client, id);
    const reactivar = r.status === 'caducada' && !r.contact_erased;
    if (r.status !== 'activa' && !reactivar) throw yaCerrada(r);
    const nueva = (await client.query(`SELECT ${VENCE_SQL} AS v`, [n])).rows[0].v;
    if (new Date(nueva) <= new Date(r.expires_at)) throw noValida('con esos días vencería antes de lo que ya vence');
    // Si ya había vencido, alguien pudo vender esas unidades: se vuelve a comprobar.
    const lineas = (await client.query('SELECT item_id, quantity FROM tpv_reservation_lines WHERE reservation_id = $1', [id])).rows;
    await apartar(client, new Map(lineas.map((l) => [l.item_id, l.quantity])), { excepto: id });
    await client.query(
      "UPDATE tpv_reservations SET expires_at = $2, extensions = extensions + 1, status = 'activa', closed_at = NULL, closed_by = NULL WHERE id = $1",
      [id, nueva],
    );
    return { antes: r.expires_at, despues: nueva, usuario, reactivada: reactivar };
  });
}

/** Lo reservado tiene que ir entero en la venta que la cierra (si no, quedaría «vendida» sin venderse). */
function cubreLaReserva(reservadas, lineas) {
  const vendido = new Map();
  for (const l of lineas ?? []) if (l.articulo_id) vendido.set(l.articulo_id, (vendido.get(l.articulo_id) ?? 0) + l.cantidad);
  return reservadas.every((l) => (vendido.get(l.item_id) ?? 0) >= l.quantity);
}

/**
 * Dentro de la transacción de la venta: la reserva pasa a «vendida» antes de
 * descontar el stock (así sus unidades ya no cuentan como reservadas). Si había
 * caducado y nadie se lo llevó, se puede vender igual. La venta tiene que llevar
 * todo lo reservado (`lineas` = las de la venta).
 */
export async function cerrarPorVenta(client, id, usuario, lineas) {
  const r = await bloquear(client, Number(id) || 0);
  if (r.status === 'vendida' || r.status === 'cancelada') throw yaCerrada(r);
  const reservadas = (await client.query('SELECT item_id, quantity FROM tpv_reservation_lines WHERE reservation_id = $1', [r.id])).rows;
  if (!cubreLaReserva(reservadas, lineas)) {
    throw new HttpError(409,
      'La venta no lleva todo lo reservado. Si el cliente se lleva otra cosa o menos, pulsa «Quitar reserva» en la venta y anula la reserva en Reservas.',
      'RESERVATION_MISMATCH');
  }
  await client.query("UPDATE tpv_reservations SET status = 'vendida', closed_at = NOW(), closed_by = $2 WHERE id = $1", [r.id, usuario.id]);
  return r;
}

export async function enlazarTicket(client, id, ticketId) {
  await client.query('UPDATE tpv_reservations SET ticket_id = $2 WHERE id = $1', [id, ticketId]);
}

/** Tarea idempotente: marca las vencidas y borra el contacto de las cerradas hace más de 30 días. */
export async function caducarReservas(db) {
  const caducadas = (await db.query(
    "UPDATE tpv_reservations SET status = 'caducada', closed_at = expires_at WHERE status = 'activa' AND expires_at <= NOW() RETURNING id",
  )).rowCount;
  const borradas = (await db.query(
    `UPDATE tpv_reservations SET customer_name = 'Cliente', phone = NULL, notes = '', cancel_reason = NULL, contact_erased = TRUE
      WHERE status <> 'activa' AND NOT contact_erased AND closed_at < NOW() - make_interval(days => $1)`, [RETENCION_CONTACTO_DIAS],
  )).rowCount;
  return { caducadas, borradas };
}
