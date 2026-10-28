// Inventario y entradas de mercancía. Cada línea de un pedido o factura se
// enlaza a un artículo (SKU con su EAN-13) y queda «pendiente» hasta que la
// mercancía llega a la tienda; al recibirla, lo recibido suma al stock y lo que
// no ha llegado queda como «falta» para reclamarlo.
import { HttpError } from '../http-error.js';
import { normalizarRef, withTransaction } from '../proveedores/repo.js';
import { nuevoCodigo } from './barcode.js';

const MAX_LINEAS = 2000;
const MAX_CANTIDAD = 1000;
const MAX_CENTS = 10_000_000; // 100.000,00 €
const MAX_TALLA = 60;
const MAX_ID = 2_147_483_647;
const MAX_INVENTARIO = 3000;
const MAX_ETIQUETAS = 5000;
const INTENTOS_CODIGO = 10;

const texto = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const centimos = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const centValido = (n) => n === null || (Number.isInteger(n) && n >= 0 && n <= MAX_CENTS);
const idValido = (n) => Number.isInteger(n) && n > 0 && n <= MAX_ID;

function invalid(errores) {
  return new HttpError(400, `Datos no válidos: ${errores.slice(0, 5).join('; ')}${errores.length > 5 ? '…' : ''}.`, 'INVALID_LINES');
}

/* ---------- Validación ---------- */

/**
 * Normaliza las líneas de producto que llegan del formulario de importación.
 * Junta las repetidas (mismo SKU) sumando cantidades. Las de 0 unidades (una
 * talla de un tramo en la que no viene nada) se ignoran.
 * @returns {{ marca, modelo, referencia, color, talla, cantidad, coste_cent, pvp_cent }[]}
 */
export function validarLineas(lineas, marcaPorDefecto = '') {
  if (lineas == null) return [];
  if (!Array.isArray(lineas)) throw invalid(['las líneas de producto deben ser una lista']);
  if (lineas.length > MAX_LINEAS) throw invalid([`como mucho ${MAX_LINEAS} líneas por documento`]);
  const errores = [];
  const porSku = new Map();
  lineas.forEach((l, i) => {
    const n = i + 1;
    if (Number(l?.cantidad) === 0) return;
    const marca = texto(l?.marca ?? marcaPorDefecto, 50);
    const referencia = texto(l?.referencia, 50);
    const modelo = texto(l?.modelo, 100) || referencia;
    const color = texto(l?.color, 50);
    const talla = Number(l?.talla ?? 0);
    const cantidad = Number(l?.cantidad);
    const coste = centimos(l?.coste_cent);
    const pvp = centimos(l?.pvp_cent);
    if (!marca) errores.push(`línea ${n}: falta la marca`);
    if (!referencia) errores.push(`línea ${n}: falta la referencia`);
    if (!color) errores.push(`línea ${n}: falta el color`);
    if (!Number.isInteger(talla) || talla < 0 || talla > MAX_TALLA) errores.push(`línea ${n}: talla no válida`);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) errores.push(`línea ${n}: cantidad no válida`);
    if (!centValido(coste)) errores.push(`línea ${n}: coste no válido`);
    if (!centValido(pvp)) errores.push(`línea ${n}: PVP no válido`);
    const key = [marca, modelo, referencia, color, talla].join('|').toLowerCase();
    const previa = porSku.get(key);
    porSku.set(key, previa
      ? { ...previa, cantidad: previa.cantidad + cantidad, coste_cent: previa.coste_cent ?? coste, pvp_cent: previa.pvp_cent ?? pvp }
      : { marca, modelo, referencia, color, talla, cantidad, coste_cent: coste, pvp_cent: pvp });
  });
  if (errores.length) throw invalid(errores);
  return [...porSku.values()];
}

/* ---------- Artículos ---------- */

/** Busca el SKU; si no existe lo crea con un EAN-13 nuevo. Actualiza coste y PVP si vienen. */
export async function obtenerOCrearArticulo(db, l) {
  const sku = [l.marca, l.modelo, l.referencia, l.color, l.talla];
  const existente = (await db.query(
    `SELECT id, barcode FROM inventory_items
      WHERE lower(brand) = lower($1) AND lower(model) = lower($2) AND lower(reference) = lower($3)
        AND lower(color) = lower($4) AND size = $5 LIMIT 1`, sku)).rows[0];
  if (existente) {
    if (l.coste_cent != null || l.pvp_cent != null) {
      await db.query(`UPDATE inventory_items SET cost_cents = COALESCE($2, cost_cents), sale_price_cents = COALESCE($3, sale_price_cents),
        updated_at = NOW() WHERE id = $1`, [existente.id, l.coste_cent, l.pvp_cent]);
    }
    return { id: existente.id, codigo: existente.barcode, creado: false };
  }
  for (let intento = 0; intento < INTENTOS_CODIGO; intento += 1) {
    const codigo = nuevoCodigo();
    const libre = (await db.query('SELECT 1 FROM inventory_items WHERE barcode = $1', [codigo])).rowCount === 0;
    if (!libre) continue;
    const row = (await db.query(
      `INSERT INTO inventory_items (brand, model, reference, color, size, barcode, cost_cents, sale_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [...sku, codigo, l.coste_cent, l.pvp_cent],
    )).rows[0];
    return { id: row.id, codigo, creado: true };
  }
  throw new HttpError(500, 'No se pudo generar un código de barras único.', 'BARCODE_EXHAUSTED');
}

/* ---------- Entradas (mercancía de un documento) ---------- */

/**
 * Documento enlazado del mismo proveedor que ya tiene los productos dados de
 * alta: para una factura, el pedido que cita; para un pedido, la factura que lo
 * cita. Así la misma mercancía no entra dos veces (sea cual sea el orden).
 */
export async function documentoConProductos(db, { tipo, proveedorId = null, cif = null, nombre = null, numero = null, pedidos = [], excluir = null }) {
  const rows = (await db.query(`
    SELECT d.id, d.kind, d.number, d.orders FROM supplier_docs d JOIN suppliers s ON s.id = d.supplier_id
     WHERE d.kind = $4 AND d.id <> $5 AND EXISTS (SELECT 1 FROM inventory_incoming i WHERE i.doc_id = d.id)
       AND (s.id = $1 OR (s.cif IS NOT NULL AND s.cif = $2) OR lower(s.name) = lower($3))`,
  [proveedorId, cif ?? '', nombre ?? '', tipo === 'factura' ? 'pedido' : 'factura', excluir ?? 0])).rows;
  let r;
  if (tipo === 'factura') {
    const refs = new Set((pedidos ?? []).map(normalizarRef).filter(Boolean));
    r = rows.find((x) => refs.has(normalizarRef(x.number)));
  } else {
    const ref = normalizarRef(numero);
    r = ref ? rows.find((x) => (x.orders ?? []).some((p) => normalizarRef(p) === ref)) : null;
  }
  return r ? { id: r.id, tipo: r.kind, numero: r.number } : null;
}

/**
 * Registra la mercancía de un documento como pendiente de recibir. Si su
 * pedido (o su factura) ya tiene los productos, no los duplica.
 */
export async function registrarEntrada(db, doc, lineasEntrada, marcaPorDefecto) {
  const lineas = validarLineas(lineasEntrada, marcaPorDefecto);
  if (!lineas.length) return { lineas: 0, unidades: 0, articulos_nuevos: 0, omitido: null };
  const enlazado = await documentoConProductos(db, { tipo: doc.tipo, proveedorId: doc.proveedor_id, numero: doc.numero, pedidos: doc.pedidos, excluir: doc.id });
  if (enlazado) return { lineas: 0, unidades: 0, articulos_nuevos: 0, omitido: enlazado };
  const ya = await db.query('SELECT 1 FROM inventory_incoming WHERE doc_id = $1 LIMIT 1', [doc.id]);
  if (ya.rowCount) throw new HttpError(409, 'Este documento ya tiene sus productos registrados.', 'LINES_EXIST');
  let nuevos = 0;
  for (const l of lineas) {
    const art = await obtenerOCrearArticulo(db, l);
    if (art.creado) nuevos += 1;
    await db.query('INSERT INTO inventory_incoming (doc_id, item_id, quantity) VALUES ($1, $2, $3)', [doc.id, art.id, l.cantidad]);
  }
  return { lineas: lineas.length, unidades: lineas.reduce((s, l) => s + l.cantidad, 0), articulos_nuevos: nuevos, omitido: null };
}

const LINEA_COLUMNS = `
  i.id, i.doc_id, i.quantity, i.received_qty, i.state, i.received_at,
  a.id AS item_id, a.brand, a.model, a.reference, a.color, a.size, a.barcode, a.stock, a.sale_price_cents, a.cost_cents`;

function lineaPublica(r) {
  return {
    id: r.id,
    documento_id: r.doc_id,
    cantidad: r.quantity,
    recibidas: r.received_qty,
    faltan: r.state === 'falta' ? r.quantity - r.received_qty : 0,
    estado: r.state,
    recibido_en: r.received_at,
    articulo: articuloPublico({ ...r, id: r.item_id }),
  };
}

function articuloPublico(r) {
  return {
    id: r.id,
    marca: r.brand,
    modelo: r.model,
    referencia: r.reference,
    color: r.color,
    talla: r.size,
    codigo: r.barcode,
    stock: r.stock,
    pvp_cent: r.sale_price_cents,
    coste_cent: r.cost_cents,
  };
}

function totalesDe(lineas) {
  const suma = (fn) => lineas.reduce((s, l) => s + fn(l), 0);
  return {
    lineas: lineas.length,
    unidades: suma((l) => l.cantidad),
    pendientes: suma((l) => (l.estado === 'pendiente' ? l.cantidad : 0)),
    recibidas: suma((l) => l.recibidas),
    faltan: suma((l) => l.faltan),
  };
}

/** Mercancía de un documento, línea a línea. */
export async function obtenerEntrada(db, docId) {
  const doc = (await db.query(`
    SELECT d.id, d.kind, d.number, to_char(d.doc_date, 'YYYY-MM-DD') AS fecha, to_char(d.delivery_date, 'YYYY-MM-DD') AS entrega,
           s.id AS proveedor_id, s.name AS proveedor
      FROM supplier_docs d JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = $1`, [docId])).rows[0];
  if (!doc) throw new HttpError(404, 'Documento no encontrado.', 'DOC_NOT_FOUND');
  const lineas = (await db.query(`SELECT ${LINEA_COLUMNS} FROM inventory_incoming i JOIN inventory_items a ON a.id = i.item_id
    WHERE i.doc_id = $1 ORDER BY a.reference, a.color, a.size, i.id`, [docId])).rows.map(lineaPublica);
  return {
    documento: { id: doc.id, tipo: doc.kind, numero: doc.number, fecha: doc.fecha, fecha_entrega: doc.entrega, proveedor: { id: doc.proveedor_id, nombre: doc.proveedor } },
    lineas,
    totales: totalesDe(lineas),
  };
}

/** Documentos con mercancía. `estado`: pendientes (por recibir), faltas (por reclamar) o todas. */
export async function listarEntradas(db, { estado = 'pendientes' } = {}) {
  const filtro = estado === 'faltas' ? "HAVING bool_or(i.state = 'falta')"
    : estado === 'todas' ? '' : "HAVING bool_or(i.state = 'pendiente')";
  const rows = (await db.query(`
    SELECT d.id, d.kind, d.number, to_char(d.doc_date, 'YYYY-MM-DD') AS fecha, to_char(d.delivery_date, 'YYYY-MM-DD') AS entrega,
           s.name AS proveedor, count(*)::int AS lineas, sum(i.quantity)::int AS unidades,
           sum(CASE WHEN i.state = 'pendiente' THEN i.quantity ELSE 0 END)::int AS pendientes,
           sum(i.received_qty)::int AS recibidas,
           sum(CASE WHEN i.state = 'falta' THEN i.quantity - i.received_qty ELSE 0 END)::int AS faltan,
           max(i.received_at) AS recibido_en
      FROM inventory_incoming i JOIN supplier_docs d ON d.id = i.doc_id JOIN suppliers s ON s.id = d.supplier_id
     GROUP BY d.id, s.name ${filtro}
     ORDER BY d.delivery_date NULLS LAST, d.doc_date, d.id`)).rows;
  return rows.map((r) => ({
    id: r.id, tipo: r.kind, numero: r.number, fecha: r.fecha, fecha_entrega: r.entrega, proveedor: r.proveedor,
    totales: { lineas: r.lineas, unidades: r.unidades, pendientes: r.pendientes, recibidas: r.recibidas, faltan: r.faltan },
    recibido_en: r.recibido_en,
  }));
}

/**
 * Recepción: todo lo pendiente del documento se da por recibido salvo lo
 * indicado en `faltan` ({ idLinea: unidades que no han llegado }).
 */
export async function recibirEntrada(pool, docId, faltan = {}, userId = null) {
  if (faltan === null || typeof faltan !== 'object' || Array.isArray(faltan)) throw invalid(['«faltan» debe ser un objeto']);
  return withTransaction(pool, async (client) => {
    const pendientes = (await client.query(
      "SELECT id, item_id, quantity FROM inventory_incoming WHERE doc_id = $1 AND state = 'pendiente' ORDER BY id FOR UPDATE",
      [docId],
    )).rows;
    if (!pendientes.length) throw new HttpError(409, 'No queda nada pendiente de recibir en este documento.', 'NOTHING_PENDING');
    const ids = new Set(pendientes.map((p) => String(p.id)));
    const ajenas = Object.keys(faltan).filter((k) => !ids.has(String(k)));
    if (ajenas.length) throw invalid(['hay líneas marcadas que no están pendientes en este documento']);
    let recibidas = 0;
    let faltanTotal = 0;
    for (const p of pendientes) {
      const f = Number(faltan[p.id] ?? 0);
      if (!Number.isInteger(f) || f < 0 || f > p.quantity) throw invalid([`unidades que faltan no válidas en la línea ${p.id}`]);
      const llegan = p.quantity - f;
      if (llegan) await client.query('UPDATE inventory_items SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [p.item_id, llegan]);
      await client.query(
        'UPDATE inventory_incoming SET received_qty = $2, state = $3, received_at = NOW(), received_by = $4 WHERE id = $1',
        [p.id, llegan, f > 0 ? 'falta' : 'recibido', userId],
      );
      recibidas += llegan;
      faltanTotal += f;
    }
    return { recibidas, faltan: faltanTotal, entrada: await obtenerEntrada(client, docId) };
  });
}

/** Una línea con faltas: «llegado» (lo que faltaba entra en stock) o «anular» (no llegará). */
export async function resolverFalta(pool, lineaId, accion, userId = null) {
  if (!['llegado', 'anular'].includes(accion)) throw invalid(['acción no válida']);
  return withTransaction(pool, async (client) => {
    const l = (await client.query("SELECT id, doc_id, item_id, quantity, received_qty, state FROM inventory_incoming WHERE id = $1 FOR UPDATE", [lineaId])).rows[0];
    if (!l) throw new HttpError(404, 'Esa línea no existe.', 'LINE_NOT_FOUND');
    if (l.state !== 'falta') throw new HttpError(409, 'Esa línea no tiene unidades pendientes de reclamar.', 'NOT_MISSING');
    const resto = l.quantity - l.received_qty;
    if (accion === 'llegado') {
      await client.query('UPDATE inventory_items SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [l.item_id, resto]);
      await client.query("UPDATE inventory_incoming SET received_qty = quantity, state = 'recibido', received_at = NOW(), received_by = $2 WHERE id = $1", [l.id, userId]);
    } else {
      await client.query("UPDATE inventory_incoming SET state = 'anulado' WHERE id = $1", [l.id]);
    }
    return { unidades: resto, docId: l.doc_id, entrada: await obtenerEntrada(client, l.doc_id) };
  });
}

/* ---------- Inventario ---------- */

/** Filtros: { q, estado: 'disponible' | 'pendiente' | 'faltas' | 'todos' }. */
export async function listarInventario(db, { q = '', estado = 'todos' } = {}) {
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push('(a.brand ILIKE $1 OR a.model ILIKE $1 OR a.reference ILIKE $1 OR a.color ILIKE $1 OR a.barcode ILIKE $1)');
  }
  const having = { disponible: 'a.stock > 0', pendiente: 'pendiente > 0', faltas: 'faltan > 0' }[estado];
  const rows = (await db.query(`
    SELECT * FROM (
      SELECT a.*,
        COALESCE((SELECT sum(i.quantity) FROM inventory_incoming i WHERE i.item_id = a.id AND i.state = 'pendiente'), 0)::int AS pendiente,
        COALESCE((SELECT sum(i.quantity - i.received_qty) FROM inventory_incoming i WHERE i.item_id = a.id AND i.state = 'falta'), 0)::int AS faltan
      FROM inventory_items a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ) a ${having ? `WHERE ${having}` : ''}
    ORDER BY lower(a.brand), lower(a.model), a.reference, lower(a.color), a.size
    LIMIT ${MAX_INVENTARIO}`, params)).rows;
  return rows.map((r) => ({ ...articuloPublico(r), pendiente: r.pendiente, faltan: r.faltan }));
}

export async function resumenInventario(db) {
  const r = (await db.query(`
    SELECT (SELECT COALESCE(sum(stock), 0) FROM inventory_items)::int AS disponible,
           (SELECT count(*) FROM inventory_items WHERE stock > 0)::int AS articulos,
           (SELECT COALESCE(sum(quantity), 0) FROM inventory_incoming WHERE state = 'pendiente')::int AS pendiente,
           (SELECT COALESCE(sum(quantity - received_qty), 0) FROM inventory_incoming WHERE state = 'falta')::int AS faltan`)).rows[0];
  return r;
}

/** Cambia el PVP (y, si hace falta, modelo o color) de un artículo. */
export async function actualizarArticulo(db, id, { pvp_cent: pvpIn, modelo, color }) {
  const row = (await db.query('SELECT * FROM inventory_items WHERE id = $1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Artículo no encontrado.', 'ITEM_NOT_FOUND');
  const pvp = pvpIn === undefined ? row.sale_price_cents : centimos(pvpIn);
  if (!centValido(pvp)) throw invalid(['PVP no válido']);
  const after = {
    model: modelo === undefined ? row.model : texto(modelo, 100) || row.model,
    color: color === undefined ? row.color : texto(color, 50) || row.color,
    sale_price_cents: pvp,
  };
  try {
    await db.query('UPDATE inventory_items SET model = $2, color = $3, sale_price_cents = $4, updated_at = NOW() WHERE id = $1',
      [id, after.model, after.color, after.sale_price_cents]);
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'Ya existe otro artículo con esa marca, modelo, referencia, color y talla.', 'SKU_TAKEN');
    throw error;
  }
  return { before: articuloPublico(row), after: articuloPublico({ ...row, ...after }) };
}

/* ---------- Etiquetas ---------- */

/**
 * Etiquetas a imprimir: una por unidad. De un documento (todas sus líneas o
 * solo `lineas`) o de un artículo suelto (`articulo` × `copias`).
 */
export async function etiquetasPara(db, { docId = null, lineas = null, articulo = null, copias = 1 }) {
  let rows;
  if (articulo) {
    if (!idValido(articulo)) throw new HttpError(404, 'Artículo no encontrado.', 'ITEM_NOT_FOUND');
    const n = Number(copias);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw invalid(['número de copias no válido']);
    const a = (await db.query('SELECT * FROM inventory_items WHERE id = $1', [articulo])).rows[0];
    if (!a) throw new HttpError(404, 'Artículo no encontrado.', 'ITEM_NOT_FOUND');
    rows = [{ ...a, unidades: n }];
  } else {
    if (!idValido(docId)) throw new HttpError(404, 'Documento no encontrado.', 'DOC_NOT_FOUND');
    const ids = lineas ? lineas.map(Number).filter(idValido) : null;
    rows = (await db.query(`SELECT a.*, i.quantity AS unidades FROM inventory_incoming i JOIN inventory_items a ON a.id = i.item_id
      WHERE i.doc_id = $1 AND i.state <> 'anulado' ${ids ? 'AND i.id = ANY($2::int[])' : ''}
      ORDER BY a.reference, a.color, a.size, i.id`, ids ? [docId, ids] : [docId])).rows;
  }
  const etiquetas = rows.flatMap((r) => Array.from({ length: r.unidades }, () => articuloPublico(r)));
  if (etiquetas.length > MAX_ETIQUETAS) throw invalid([`como mucho ${MAX_ETIQUETAS} etiquetas de una vez`]);
  return etiquetas;
}
