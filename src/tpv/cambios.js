// Cambios: el cliente devuelve productos y se lleva otros o un vale. Lo
// devuelto vale lo que se pagó en su venta del TPV (con sus descuentos); si se
// compró antes del TPV, el importe del ticket de papel, con aprobación de un
// Administrador. Pasados 30 días desde la compra, también hace falta aprobación.
// Cada producto devuelto vuelve al stock o es «defectuoso»: entonces va a
// cuarentena con una incidencia de garantía (que no se limita a los 30 días:
// la garantía legal es de 3 años) y el cliente puede pedir su dinero en vez del vale.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { crearTicket, leerPagos, prepararVenta } from './repo.js';
import { abrirIncidencias } from './garantias.js';
import { emitirVale } from './vales.js';

export const PLAZO_DIAS = 30;
export const PLAZO_GARANTIA_DIAS = 3 * 365 + 1;
export const ESTADOS = Object.freeze(['stock', 'defectuoso']);
const METODOS_REEMBOLSO = Object.freeze(['efectivo', 'tarjeta', 'bizum']);
const MAX_DEFECTO = 300;
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
 * Con `reembolso` (el cliente se lleva su dinero por lo defectuoso), quien no
 * es Administrador necesita aprobación. `huella` identifica exactamente lo que
 * se aprueba (líneas, estado y dinero): la aprobación no sirve para otro cambio.
 */
export async function valorarDevueltos(db, devueltos, { bloquear = false, reembolso = null } = {}) {
  if (!Array.isArray(devueltos) || !devueltos.length) throw invalido('no hay nada devuelto');
  if (devueltos.length > MAX_DEVUELTOS) throw invalido(`como mucho ${MAX_DEVUELTOS} productos`);
  if (bloquear) {
    // Siempre en el mismo orden: dos cambios a la vez con las mismas ventas no se bloquean entre sí.
    const ids = [...new Set(devueltos.map((d) => Number(d.linea_id)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    if (ids.length) await db.query('SELECT id FROM tpv_ticket_lines WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
  }
  const lineas = [];
  const pedidasPorLinea = new Map(); // la misma venta repetida en el cambio cuenta junta
  for (const d of devueltos) {
    const cantidad = Number(d.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) throw invalido('cantidad no válida');
    const { estado, defecto } = leerEstado(d);
    const plazo = estado === 'defectuoso' ? PLAZO_GARANTIA_DIAS : PLAZO_DIAS;
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
        credito: Math.round((l.total_cents * cantidad) / l.quantity), ticket: l.number, dia: l.dia, fuera_plazo: l.dias > plazo, papel: false, estado, defecto,
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
      ticket: String(d.ticket_papel ?? '').trim().slice(0, 40) || null, dia: fecha, fuera_plazo: dias != null && dias > plazo, papel: true, estado, defecto,
    });
  }
  const motivos = [];
  if (lineas.some((l) => l.papel)) motivos.push('ticket de papel');
  if (lineas.some((l) => l.fuera_plazo && l.estado === 'stock')) motivos.push(`más de ${PLAZO_DIAS} días`);
  if (lineas.some((l) => l.fuera_plazo && l.estado === 'defectuoso')) motivos.push('fuera de la garantía de 3 años');
  const conDinero = reembolso == null || reembolso === '' ? null : String(reembolso);
  if (conDinero) motivos.push('devolución de dinero');
  return {
    huella: JSON.stringify({
      l: lineas.map((l) => [l.sold_line_id, l.item_id, l.descripcion, l.cantidad, l.credito, l.estado, l.ticket]), r: conDinero,
    }),
    lineas,
    credito: lineas.reduce((s, l) => s + l.credito, 0),
    defectuoso: lineas.filter((l) => l.estado === 'defectuoso').reduce((s, l) => s + l.credito, 0),
    requiere_aprobacion: motivos.length > 0,
    motivos,
  };
}

/** En buen estado (vuelve al stock) o defectuoso (cuarentena), con qué le pasa. */
function leerEstado(d) {
  const estado = d.estado == null || d.estado === '' ? 'stock' : String(d.estado);
  if (!ESTADOS.includes(estado)) throw invalido('el estado del producto devuelto no es válido');
  if (estado === 'stock') return { estado, defecto: null };
  const defecto = String(d.defecto ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_DEFECTO);
  if (defecto.length < 3) throw invalido('escribe qué defecto tiene el producto');
  return { estado, defecto };
}

/** Lo que sobra tras lo nuevo: hasta lo que vale lo defectuoso se puede devolver en dinero; el resto, vale. */
function reparto(dev, totalNuevos, metodo) {
  const sobra = Math.max(0, dev.credito - totalNuevos);
  const reembolsable = Math.min(sobra, dev.defectuoso);
  if (metodo == null || metodo === '') return { reembolsable, reembolso: 0, metodo: null, vale: sobra };
  if (!METODOS_REEMBOLSO.includes(metodo)) throw invalido('el dinero se devuelve en efectivo, tarjeta o Bizum');
  if (!reembolsable) throw invalido('solo se devuelve dinero por productos defectuosos (y lo que no se gaste en lo nuevo)');
  return { reembolsable, reembolso: reembolsable, metodo, vale: sobra - reembolsable };
}

/** Lo nuevo que se lleva (con los precios del stock; en un cambio no hay descuentos). */
async function valorarNuevos(db, nuevos) {
  if (!Array.isArray(nuevos) || !nuevos.length) return null;
  return prepararVenta(db, { lineas: nuevos.map((l) => ({ ...l, descuento: null })) });
}

/** Cálculo completo del cambio, para la pantalla: crédito, lo nuevo, lo que paga y el vale que se lleva. */
export async function calcularCambio(db, cambio) {
  const dev = await valorarDevueltos(db, cambio?.devueltos, { reembolso: cambio?.reembolso });
  const nuevos = await valorarNuevos(db, cambio?.nuevos);
  const totalNuevos = nuevos?.total_cent ?? 0;
  const r = reparto(dev, totalNuevos, cambio?.reembolso);
  return {
    devueltos: dev.lineas, credito_cent: dev.credito, defectuoso_cent: dev.defectuoso, requiere_aprobacion: dev.requiere_aprobacion, motivos: dev.motivos,
    nuevos: nuevos?.lineas ?? [], nuevos_cent: totalNuevos, a_pagar_cent: Math.max(0, totalNuevos - dev.credito),
    reembolsable_cent: r.reembolsable, reembolso_cent: r.reembolso, vale_cent: r.vale,
  };
}

/**
 * Registra el cambio en dos documentos: la rectificativa (serie R) con lo
 * devuelto y, si se lleva algo, una venta normal (serie T) pagada con ese
 * abono y, si vale más, con la diferencia. Lo que está bien vuelve al stock;
 * lo defectuoso, a cuarentena con su incidencia de garantía. Si sobra abono,
 * va a un vale o, por lo defectuoso y si el cliente lo pide (`reembolso`: el
 * método), se le devuelve el dinero. `comprobarAprobacion(credito)` valida la aprobación si hace falta.
 */
export async function registrarCambio(pool, { cambio, vendedor, comprobarAprobacion, valeMeses }) {
  return withTransaction(pool, async (client) => {
    const dev = await valorarDevueltos(client, cambio?.devueltos, { bloquear: true, reembolso: cambio?.reembolso });
    const nuevos = await valorarNuevos(client, cambio?.nuevos);
    const totalNuevos = nuevos?.total_cent ?? 0;
    const aPagar = Math.max(0, totalNuevos - dev.credito);
    const pagos = leerPagos(aPagar ? cambio.pagos : [], aPagar);
    const r = reparto(dev, totalNuevos, cambio?.reembolso);
    const aprobacionId = dev.requiere_aprobacion && vendedor.role !== 'admin' ? await comprobarAprobacion(client, dev) : null;
    const rect = await crearTicket(client, {
      calculo: null, pagos: [], vendedor, aprobacionId, tipo: 'rectificativa', serie: 'R', totalCent: dev.credito, creditoCent: dev.credito,
    });
    if (r.reembolso) await client.query('UPDATE tpv_tickets SET refund_cents = $2, refund_method = $3 WHERE id = $1', [rect.id, r.reembolso, r.metodo]);
    const defectuosas = [];
    for (const l of dev.lineas) {
      const linea = (await client.query(
        `INSERT INTO tpv_return_lines (ticket_id, item_id, sold_line_id, description, size, quantity, credit_cents, paper_ticket, sold_on, condition)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [rect.id, l.item_id, l.sold_line_id, l.descripcion, l.talla, l.cantidad, l.credito, l.papel ? l.ticket : null, l.dia, l.estado],
      )).rows[0];
      // Lo que está bien vuelve al stock; lo defectuoso no se vende (cuarentena).
      if (l.estado === 'defectuoso') defectuosas.push({ ...l, return_line_id: linea.id });
      else if (l.item_id) await client.query('UPDATE inventory_items SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [l.item_id, l.cantidad]);
    }
    const incidencias = await abrirIncidencias(client, { ticketId: rect.id, lineas: defectuosas, usuario: vendedor });
    let venta = null;
    if (nuevos?.lineas?.length) {
      const abono = Math.min(dev.credito, totalNuevos);
      const conAbono = abono ? [{ metodo: 'abono', importe: abono, entregado: null, creditTicketId: rect.id }, ...pagos] : pagos;
      venta = await crearTicket(client, { calculo: nuevos, pagos: conAbono, vendedor, abonoDeId: rect.id });
    }
    const vale = r.vale ? await emitirVale(client, { importe: r.vale, ticketId: rect.id, usuario: vendedor, meses: valeMeses }) : null;
    return {
      rectificativa: rect, venta, vale, credito: dev.credito, motivos: dev.motivos, sin_stock: venta?.sin_stock ?? [],
      reembolso: r.reembolso ? { importe: r.reembolso, metodo: r.metodo } : null, incidencias,
    };
  });
}
