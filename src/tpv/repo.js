// Ventas del TPV: búsqueda de artículos, cálculo con los precios del stock,
// alta del ticket (con su número), sus pagos y la salida del stock.
import { calcularVenta } from '../../public/tpv/calculo.js';
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { cerrarPorVenta, comprobarNoReservado, enlazarTicket, reservadoPorArticulo } from './reservas.js';
import { cobrarConVales, formatoCodigo } from './vales.js';

export const METODOS = Object.freeze(['efectivo', 'tarjeta', 'bizum', 'bonos', 'vales']);
const MAX_GRUPOS = 30;
const MAX_LINEAS = 100;
const CANDADO_NUMERO = 727101;
const TZ = 'Atlantic/Canary';

const invalida = (msg) => new HttpError(400, `Venta no válida: ${msg}.`, 'INVALID_SALE');
const texto = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

const articulo = (r, reservado = new Map()) => ({
  id: r.id, tipo: r.type, marca: r.brand, modelo: r.model, referencia: r.reference, color: r.color, talla: r.size,
  detalle: r.detail, codigo: r.barcode, stock: r.stock, pvp_cent: r.sale_price_cents, reservado: reservado.get(r.id) ?? 0,
});

/**
 * Lo que escribe o escanea quien vende: un código de barras (el nuestro o el
 * de fábrica) da el artículo exacto; si no, se busca por texto y salen los
 * modelos con sus tallas.
 */
export async function buscarArticulos(db, q) {
  const consulta = texto(q, 100);
  if (!consulta) return { exacto: null, modelos: [] };
  if (/^\d{8,14}$/.test(consulta)) {
    const r = (await db.query('SELECT * FROM inventory_items WHERE barcode = $1 OR maker_barcode = $1 LIMIT 1', [consulta])).rows[0];
    if (r) return { exacto: articulo(r, await reservadoPorArticulo(db, [r.id])), modelos: [] };
  }
  const palabras = consulta.split(' ').slice(0, 5).map((p) => `%${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  // Cada palabra tiene que aparecer en algún campo («bota marino» encuentra la bota en color marino).
  const condiciones = palabras.map((_, i) => `(a.brand || ' ' || a.model || ' ' || a.reference || ' ' || a.color || ' ' || a.detail) ILIKE $${i + 2}`);
  const rows = (await db.query(
    `SELECT a.* FROM inventory_items a
      WHERE (a.barcode = $1 OR ${condiciones.join(' AND ')})
      ORDER BY lower(a.brand), lower(a.model), a.reference, lower(a.color), a.size_order LIMIT 600`,
    [consulta, ...palabras],
  )).rows;
  const reservado = await reservadoPorArticulo(db, rows.map((r) => r.id));
  const grupos = new Map();
  for (const r of rows) {
    const k = [r.brand, r.reference, r.model, r.color].join('|').toLowerCase();
    if (!grupos.has(k)) grupos.set(k, { marca: r.brand, referencia: r.reference, modelo: r.model, color: r.color, tipo: r.type, detalle: r.detail, tallas: [] });
    grupos.get(k).tallas.push(articulo(r, reservado));
  }
  return { exacto: null, modelos: [...grupos.values()].slice(0, MAX_GRUPOS) };
}

/**
 * Normaliza la venta que manda la pantalla y le pone los precios del stock
 * (el PVP de un artículo no se puede cambiar desde la caja: para eso están los
 * descuentos). Devuelve las líneas listas para calcular.
 */
export async function prepararVenta(db, venta) {
  const entrada = venta?.lineas;
  if (!Array.isArray(entrada) || !entrada.length) throw invalida('no tiene productos');
  if (entrada.length > MAX_LINEAS) throw invalida(`como mucho ${MAX_LINEAS} líneas`);
  const ids = [...new Set(entrada.map((l) => Number(l.articulo_id)).filter((n) => Number.isInteger(n) && n > 0))];
  const items = new Map((ids.length ? (await db.query('SELECT * FROM inventory_items WHERE id = ANY($1)', [ids])).rows : []).map((r) => [r.id, r]));
  const lineas = entrada.map((l, i) => {
    const id = l.articulo_id == null || l.articulo_id === '' ? null : Number(l.articulo_id);
    const descuento = l.descuento && l.descuento.valor !== '' && l.descuento.valor != null
      ? { tipo: l.descuento.tipo === 'eur' ? 'eur' : 'pct', valor: Number(l.descuento.valor) } : null;
    if (id !== null) {
      const a = items.get(id);
      if (!a) throw invalida(`el artículo de la línea ${i + 1} no existe`);
      const precio = a.sale_price_cents ?? Number(l.precio_cent);
      if (!Number.isInteger(precio) || precio <= 0) throw invalida(`«${a.brand} ${a.reference}» no tiene PVP: ponlo en Inventario o escribe el precio`);
      const desc = [a.brand, a.model !== a.reference ? a.model : null, a.reference, a.color].filter(Boolean).join(' · ');
      return {
        articulo_id: a.id, descripcion: desc, codigo: a.barcode, talla: a.size, tipo: a.type, coste_cent: a.cost_cents,
        precio_cent: precio, cantidad: Number(l.cantidad), descuento,
      };
    }
    const descripcion = texto(l.descripcion, 80);
    if (!descripcion) throw invalida(`falta el concepto del artículo libre de la línea ${i + 1}`);
    return {
      articulo_id: null, descripcion, codigo: null, talla: null, tipo: l.tipo && ['calzado', 'ropa', 'accesorios', 'juguetes'].includes(l.tipo) ? l.tipo : null,
      coste_cent: null, precio_cent: Number(l.precio_cent), cantidad: Number(l.cantidad), descuento,
    };
  });
  const descuento = venta.descuento && venta.descuento.valor !== '' && venta.descuento.valor != null
    ? { tipo: venta.descuento.tipo === 'eur' ? 'eur' : 'pct', valor: Number(venta.descuento.valor) } : null;
  try {
    return { ...calcularVenta(lineas, descuento), descuento_ticket: descuento };
  } catch (error) {
    if (error instanceof RangeError) throw invalida(error.message);
    throw error;
  }
}

/** Pagos de la pantalla. Con vale hay que indicar su código (`vale`). Si no hay nada que pagar, no hace falta ninguno. */
export function leerPagos(pagos, total) {
  if (total === 0 && (!Array.isArray(pagos) || !pagos.length)) return [];
  if (!Array.isArray(pagos) || !pagos.length) throw invalida('falta el cobro');
  const lista = pagos.map((p) => {
    const metodo = String(p.metodo);
    const importe = Number(p.importe_cent);
    const entregado = p.entregado_cent == null || p.entregado_cent === '' ? null : Number(p.entregado_cent);
    if (!METODOS.includes(metodo)) throw invalida('método de pago no válido');
    if (!Number.isInteger(importe) || importe <= 0) throw invalida('importe de pago no válido');
    if (entregado !== null && (metodo !== 'efectivo' || !Number.isInteger(entregado) || entregado < importe)) throw invalida('el efectivo entregado no cubre su importe');
    return { metodo, importe, entregado, vale: metodo === 'vales' ? p.vale ?? null : null };
  });
  const suma = lista.reduce((s, p) => s + p.importe, 0);
  if (suma !== total) throw invalida(`los pagos suman ${(suma / 100).toFixed(2)} € y el total es ${(total / 100).toFixed(2)} €`);
  return lista;
}

/** Pagos con dinero (o vale): los que cuentan en `sales`. El abono de una rectificativa no es dinero nuevo. */
const esDinero = (p) => p.metodo !== 'abono';

/**
 * Alta de un ticket dentro de una transacción: número correlativo del año en
 * su serie (T = ventas, R = rectificativas), sus líneas nuevas (salen del
 * stock), sus pagos (con vales, descontando su saldo; con «abono», el de una
 * rectificativa) y cada pago en dinero en `sales` para las estadísticas.
 * Solo con la caja abierta: cada ticket cuenta en el arqueo de su caja.
 */
export async function crearTicket(client, {
  calculo, pagos, vendedor, aprobacionId = null, tipo = 'venta', creditoCent = 0, serie = 'T', totalCent = null, abonoDeId = null,
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_NUMERO]);
  const sesion = (await client.query("SELECT id FROM tpv_cash_sessions WHERE status = 'abierta' FOR SHARE")).rows[0];
  if (!sesion) throw new HttpError(409, 'La caja está cerrada: ábrela (con el recuento del dinero) para poder vender.', 'CASH_CLOSED');
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));
  const seq = (await client.query('SELECT COALESCE(max(seq), 0) + 1 AS n FROM tpv_tickets WHERE series = $1 AND year = $2', [serie, year])).rows[0].n;
  const numero = `${serie}${String(year).slice(2)}-${String(seq).padStart(6, '0')}`;
  const pagado = totalCent ?? pagos.reduce((s, p) => s + p.importe, 0);
  const cambio = pagos.reduce((s, p) => s + (p.entregado ? p.entregado - p.importe : 0), 0);
  const ticket = (await client.query(
    `INSERT INTO tpv_tickets (year, seq, number, subtotal_cents, discount_cents, total_cents, change_cents, approval_id, seller_id, seller_name, session_id,
                              kind, credit_cents, series, credit_from_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [year, seq, numero, calculo?.subtotal_cent ?? totalCent ?? 0, calculo?.descuento_cent ?? 0, pagado, cambio, aprobacionId, vendedor.id, vendedor.name ?? '',
      sesion.id, tipo, creditoCent, serie, abonoDeId],
  )).rows[0];
  // Los artículos se bloquean siempre en el mismo orden (dos ventas a la vez no se bloquean entre sí)
  // y lo reservado para otro cliente no se vende.
  const deStock = (calculo?.lineas ?? []).filter((l) => l.articulo_id);
  const idsStock = [...new Set(deStock.map((l) => l.articulo_id))].sort((a, b) => a - b);
  if (idsStock.length) {
    const fisico = (await client.query('SELECT id, stock FROM inventory_items WHERE id = ANY($1) ORDER BY id FOR UPDATE', [idsStock])).rows;
    await comprobarNoReservado(client, deStock, new Map(fisico.map((r) => [r.id, r.stock])));
  }
  const sinStock = [];
  for (const [i, l] of (calculo?.lineas ?? []).entries()) {
    let falta = false;
    if (l.articulo_id) {
      // Se vende aunque el sistema diga que no hay (el zapato está en la mano); se avisa.
      const antes = (await client.query('SELECT stock FROM inventory_items WHERE id = $1 FOR UPDATE', [l.articulo_id])).rows[0].stock;
      falta = antes < l.cantidad;
      await client.query('UPDATE inventory_items SET stock = GREATEST(stock - $2, 0), updated_at = NOW() WHERE id = $1', [l.articulo_id, l.cantidad]);
      if (falta) sinStock.push(`${l.descripcion} T. ${l.talla}`);
    }
    await client.query(
      `INSERT INTO tpv_ticket_lines (ticket_id, position, item_id, description, barcode, size, type, quantity, unit_cents, discount_cents, total_cents, cost_cents, without_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [ticket.id, i, l.articulo_id, l.descripcion, l.codigo, l.talla, l.tipo, l.cantidad, l.precio_cent, l.descuento_cent, l.total_cent, l.coste_cent, falta],
    );
  }
  for (const p of await cobrarConVales(client, pagos, ticket.id)) {
    await client.query('INSERT INTO tpv_ticket_payments (ticket_id, method, amount_cents, tendered_cents, voucher_id, credit_ticket_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [ticket.id, p.metodo, p.importe, p.entregado, p.voucherId ?? null, p.creditTicketId ?? null]);
    if (esDinero(p)) {
      await client.query('INSERT INTO sales (sold_at, total_cents, payment_method, created_by, ticket_id) VALUES (NOW(), $1, $2, $3, $4)', [p.importe, p.metodo, vendedor.id, ticket.id]);
    }
  }
  if (aprobacionId) await client.query("UPDATE tpv_discount_requests SET status = 'usado' WHERE id = $1", [aprobacionId]);
  return { id: ticket.id, numero, sin_stock: sinStock };
}

/**
 * Registra una venta. `aprobacionId` = descuento aprobado (lo comprueba quien llama).
 * Con `reservaId`, es la compra de esa reserva: se cierra como «vendida» en la misma transacción.
 */
export async function registrarVenta(pool, { venta, calculo, vendedor, aprobacionId = null, reservaId = null }) {
  const pagos = leerPagos(venta.pagos, calculo.total_cent);
  return withTransaction(pool, async (client) => {
    const reserva = reservaId ? await cerrarPorVenta(client, reservaId, vendedor, calculo.lineas) : null;
    const t = await crearTicket(client, { calculo, pagos, vendedor, aprobacionId });
    if (reserva) await enlazarTicket(client, reserva.id, t.id);
    return { ...t, reserva: reserva ? { id: reserva.id, nombre: reserva.customer_name } : null };
  });
}

/** Un ticket completo (venta o cambio), para la pantalla y para imprimirlo. */
export async function obtenerTicket(db, id, tienda) {
  const t = (await db.query(
    `SELECT t.*, to_char(t.sold_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS fecha FROM tpv_tickets t WHERE t.id = $1`, [id, TZ],
  )).rows[0];
  if (!t) throw new HttpError(404, 'Ese ticket no existe.', 'TICKET_NOT_FOUND');
  const lineas = (await db.query('SELECT * FROM tpv_ticket_lines WHERE ticket_id = $1 ORDER BY position', [id])).rows;
  const pagos = (await db.query(
    'SELECT p.*, v.code AS vale FROM tpv_ticket_payments p LEFT JOIN tpv_vouchers v ON v.id = p.voucher_id WHERE p.ticket_id = $1 ORDER BY p.id', [id],
  )).rows;
  const devueltos = (await db.query('SELECT * FROM tpv_return_lines WHERE ticket_id = $1 ORDER BY id', [id])).rows;
  const valeEmitido = (await db.query('SELECT code, amount_cents FROM tpv_vouchers WHERE origin_ticket_id = $1 LIMIT 1', [id])).rows[0] ?? null;
  // Una rectificativa resta: su base y su cuota van en negativo.
  const signo = t.kind === 'rectificativa' ? -1 : 1;
  const total = signo * t.total_cents;
  const base = Math.round(total / (1 + tienda.igic / 100));
  const ventasRectificadas = t.kind === 'rectificativa' ? (await db.query(
    `SELECT DISTINCT tt.number FROM tpv_return_lines r JOIN tpv_ticket_lines l ON l.id = r.sold_line_id JOIN tpv_tickets tt ON tt.id = l.ticket_id
      WHERE r.ticket_id = $1 ORDER BY tt.number`, [id],
  )).rows.map((r) => r.number) : [];
  const papel = devueltos.filter((d) => d.paper_ticket).map((d) => d.paper_ticket);
  const vinculado = (await db.query(
    'SELECT number FROM tpv_tickets WHERE id = $1 OR credit_from_id = $2 ORDER BY id LIMIT 1', [t.credit_from_id ?? 0, id],
  )).rows[0]?.number ?? null;
  return {
    id: t.id, tipo: t.kind, serie: t.series, numero: t.number, fecha: t.fecha, vendedor: t.seller_name,
    rectifica: [...ventasRectificadas, ...papel.map((n) => `ticket de papel ${n}`)],
    vinculado,
    subtotal_cent: t.subtotal_cents, descuento_cent: t.discount_cents, total_cent: t.total_cents, cambio_cent: t.change_cents, credito_cent: t.credit_cents,
    lineas: lineas.map((l) => ({
      descripcion: l.description, talla: l.size, codigo: l.barcode, cantidad: l.quantity, precio_cent: l.unit_cents,
      descuento_cent: l.discount_cents, total_cent: l.total_cents, sin_stock: l.without_stock,
    })),
    devueltos: devueltos.map((d) => ({ descripcion: d.description, talla: d.size, cantidad: d.quantity, credito_cent: d.credit_cents, estado: d.condition })),
    reembolso: t.refund_cents ? { metodo: t.refund_method, importe_cent: t.refund_cents } : null,
    vale_emitido: valeEmitido ? { codigo: formatoCodigo(valeEmitido.code), importe_cent: valeEmitido.amount_cents } : null,
    pagos: pagos.map((p) => ({ metodo: p.method, importe_cent: p.amount_cents, entregado_cent: p.tendered_cents, vale: p.vale ? formatoCodigo(p.vale) : null })),
    igic: { pct: tienda.igic, base_cent: base, cuota_cent: total - base },
    tienda,
  };
}

/** Lo vendido hoy en el TPV: tickets y facturación (los vales se cobran, pero no son venta nueva). */
export async function resumenHoy(db) {
  const r = (await db.query(
    `SELECT count(DISTINCT t.id)::int AS tickets,
            COALESCE(sum(p.amount_cents) FILTER (WHERE p.method NOT IN ('vales', 'abono')), 0)::int AS ventas,
            COALESCE(sum(p.amount_cents) FILTER (WHERE p.method = 'vales'), 0)::int AS vales
       FROM tpv_tickets t LEFT JOIN tpv_ticket_payments p ON p.ticket_id = t.id
      WHERE (t.sold_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date`, [TZ],
  )).rows[0];
  // Lo devuelto en dinero por defectuosos resta de lo vendido hoy.
  const reembolsos = (await db.query(
    `SELECT COALESCE(sum(refund_cents), 0)::int AS n FROM tpv_tickets WHERE (sold_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date`, [TZ],
  )).rows[0].n;
  return { tickets: r.tickets, ventas_cent: r.ventas - reembolsos, vales_cent: r.vales };
}
