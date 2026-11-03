// Cambios: el cliente devuelve productos (vuelven al stock) y se lleva otros o
// un vale. No se devuelve dinero. Lo devuelto vale lo que se pagó en su venta
// del TPV (con sus descuentos); si se compró antes del TPV, el importe del
// ticket de papel, con aprobación de un Administrador. Pasados 30 días desde
// la compra, también hace falta aprobación.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { crearTicket, leerPagos, prepararVenta } from './repo.js';
import { emitirVale } from './vales.js';

export const PLAZO_DIAS = 30;
const TZ = 'Atlantic/Canary';
const MAX_DEVUELTOS = 50;
const invalido = (msg) => new HttpError(400, `Cambio no válido: ${msg}.`, 'INVALID_EXCHANGE');

/** Lo que se sabe de un artículo escaneado para devolverlo: sus ventas en el TPV y lo que queda por devolver de cada una. */
export async function ventasDeArticulo(db, articuloId) {
  const rows = (await db.query(
    `SELECT l.id, l.quantity, l.total_cents, l.description, l.size, t.number, to_char(t.sold_at AT TIME ZONE $2, 'DD/MM/YYYY') AS fecha,
            ((NOW() AT TIME ZONE $2)::date - (t.sold_at AT TIME ZONE $2)::date) AS dias,
            COALESCE((SELECT sum(r.quantity) FROM tpv_return_lines r WHERE r.sold_line_id = l.id), 0)::int AS devueltas
       FROM tpv_ticket_lines l JOIN tpv_tickets t ON t.id = l.ticket_id
      WHERE l.item_id = $1 ORDER BY t.sold_at DESC LIMIT 20`, [articuloId, TZ],
  )).rows;
  return rows.map((r) => ({
    linea_id: r.id, ticket: r.number, fecha: r.fecha, dias: r.dias, cantidad: r.quantity, devueltas: r.devueltas,
    quedan: r.quantity - r.devueltas, precio_unidad_cent: Math.round(r.total_cents / r.quantity), dentro_plazo: r.dias <= PLAZO_DIAS,
  }));
}

/**
 * Valora lo devuelto. Cada línea es { linea_id, cantidad } (de una venta del
 * TPV) o { articulo_id?, descripcion?, cantidad, importe_cent, ticket_papel,
 * fecha_ticket } (ticket de papel: importe por unidad impreso en él).
 * Con `bloquear`, bloquea las líneas vendidas (dentro de la transacción del cambio).
 */
export async function valorarDevueltos(db, devueltos, { bloquear = false } = {}) {
  if (!Array.isArray(devueltos) || !devueltos.length) throw invalido('no hay nada devuelto');
  if (devueltos.length > MAX_DEVUELTOS) throw invalido(`como mucho ${MAX_DEVUELTOS} productos`);
  const lineas = [];
  const pedidasPorLinea = new Map(); // la misma venta repetida en el cambio cuenta junta
  for (const d of devueltos) {
    const cantidad = Number(d.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) throw invalido('cantidad no válida');
    if (d.linea_id != null) {
      const l = (await db.query(
        `SELECT l.*, t.number, ((NOW() AT TIME ZONE $2)::date - (t.sold_at AT TIME ZONE $2)::date) AS dias, (t.sold_at AT TIME ZONE $2)::date AS dia
           FROM tpv_ticket_lines l JOIN tpv_tickets t ON t.id = l.ticket_id WHERE l.id = $1 ${bloquear ? 'FOR UPDATE OF l' : ''}`,
        [Number(d.linea_id) || 0, TZ],
      )).rows[0];
      if (!l) throw invalido('esa venta no existe');
      const devueltas = (await db.query('SELECT COALESCE(sum(quantity), 0)::int AS n FROM tpv_return_lines WHERE sold_line_id = $1', [l.id])).rows[0].n;
      const pedidas = (pedidasPorLinea.get(l.id) ?? 0) + cantidad;
      pedidasPorLinea.set(l.id, pedidas);
      if (pedidas > l.quantity - devueltas) throw invalido(`del ticket ${l.number} solo quedan ${l.quantity - devueltas} por devolver`);
      lineas.push({
        item_id: l.item_id, sold_line_id: l.id, descripcion: l.description, talla: l.size, cantidad,
        credito: Math.round((l.total_cents * cantidad) / l.quantity), ticket: l.number, dia: l.dia, fuera_plazo: l.dias > PLAZO_DIAS, papel: false,
      });
      continue;
    }
    // Ticket de papel (compra de antes del TPV): el importe que pone el ticket, con aprobación.
    const unidad = Number(d.importe_cent);
    if (!Number.isInteger(unidad) || unidad <= 0 || unidad > 1_000_000) throw invalido('escribe el importe que pone el ticket');
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_ticket ?? '')) ? d.fecha_ticket : null;
    let item = null;
    if (d.articulo_id != null) item = (await db.query('SELECT id, brand, model, reference, color, size FROM inventory_items WHERE id = $1', [Number(d.articulo_id) || 0])).rows[0];
    const descripcion = item ? [item.brand, item.model !== item.reference ? item.model : null, item.reference, item.color].filter(Boolean).join(' · ')
      : String(d.descripcion ?? '').trim().slice(0, 80);
    if (!descripcion) throw invalido('falta qué producto se devuelve');
    const dias = fecha ? Math.floor((Date.now() - Date.parse(`${fecha}T12:00:00Z`)) / 86400000) : null;
    lineas.push({
      item_id: item?.id ?? null, sold_line_id: null, descripcion, talla: item?.size ?? null, cantidad, credito: unidad * cantidad,
      ticket: String(d.ticket_papel ?? '').trim().slice(0, 40) || null, dia: fecha, fuera_plazo: dias != null && dias > PLAZO_DIAS, papel: true,
    });
  }
  const motivos = [];
  if (lineas.some((l) => l.papel)) motivos.push('ticket de papel');
  if (lineas.some((l) => l.fuera_plazo)) motivos.push(`más de ${PLAZO_DIAS} días`);
  return { lineas, credito: lineas.reduce((s, l) => s + l.credito, 0), requiere_aprobacion: motivos.length > 0, motivos };
}

/** Lo nuevo que se lleva (con los precios del stock; en un cambio no hay descuentos). */
async function valorarNuevos(db, nuevos) {
  if (!Array.isArray(nuevos) || !nuevos.length) return null;
  return prepararVenta(db, { lineas: nuevos.map((l) => ({ ...l, descuento: null })) });
}

/** Cálculo completo del cambio, para la pantalla: crédito, lo nuevo, lo que paga y el vale que se lleva. */
export async function calcularCambio(db, cambio) {
  const dev = await valorarDevueltos(db, cambio?.devueltos);
  const nuevos = await valorarNuevos(db, cambio?.nuevos);
  const totalNuevos = nuevos?.total_cent ?? 0;
  return {
    devueltos: dev.lineas, credito_cent: dev.credito, requiere_aprobacion: dev.requiere_aprobacion, motivos: dev.motivos,
    nuevos: nuevos?.lineas ?? [], nuevos_cent: totalNuevos,
    a_pagar_cent: Math.max(0, totalNuevos - dev.credito), vale_cent: Math.max(0, dev.credito - totalNuevos),
  };
}

/**
 * Registra el cambio: ticket de tipo «cambio» con lo nuevo (sale del stock) y
 * lo que se paga de diferencia; lo devuelto vuelve al stock; y si sobra
 * crédito, un vale por ese importe. `comprobar(credito)` valida la aprobación si hace falta.
 */
export async function registrarCambio(pool, { cambio, vendedor, comprobarAprobacion }) {
  return withTransaction(pool, async (client) => {
    const dev = await valorarDevueltos(client, cambio?.devueltos, { bloquear: true });
    const nuevos = await valorarNuevos(client, cambio?.nuevos);
    const totalNuevos = nuevos?.total_cent ?? 0;
    const aPagar = Math.max(0, totalNuevos - dev.credito);
    const pagos = leerPagos(aPagar ? cambio.pagos : [], aPagar);
    const aprobacionId = dev.requiere_aprobacion && vendedor.role !== 'admin' ? await comprobarAprobacion(client, dev.credito) : null;
    const t = await crearTicket(client, { calculo: nuevos, pagos, vendedor, aprobacionId, tipo: 'cambio', creditoCent: dev.credito });
    for (const l of dev.lineas) {
      await client.query(
        `INSERT INTO tpv_return_lines (ticket_id, item_id, sold_line_id, description, size, quantity, credit_cents, paper_ticket, sold_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [t.id, l.item_id, l.sold_line_id, l.descripcion, l.talla, l.cantidad, l.credito, l.papel ? l.ticket : null, l.dia],
      );
      // Lo devuelto vuelve siempre al stock.
      if (l.item_id) await client.query('UPDATE inventory_items SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [l.item_id, l.cantidad]);
    }
    const sobra = Math.max(0, dev.credito - totalNuevos);
    const vale = sobra ? await emitirVale(client, { importe: sobra, ticketId: t.id, usuario: vendedor }) : null;
    return { ...t, vale, credito: dev.credito, motivos: dev.motivos };
  });
}
