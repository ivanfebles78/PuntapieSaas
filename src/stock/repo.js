// Inventario y entradas de mercancía. Cada línea de un pedido o factura se
// enlaza a un artículo (SKU con su EAN-13) y queda «pendiente» hasta que la
// mercancía llega a la tienda; al recibirla, lo recibido suma al stock y lo que
// no ha llegado queda como «falta» para reclamarlo.
import { HttpError } from '../http-error.js';
import { normalizarRef, withTransaction } from '../proveedores/repo.js';
import { esEan13, nuevoCodigo } from './barcode.js';
import { asegurarMarcas } from './catalogo.js';
import { esTipo, tallaParaTipo, tipoPorDefecto, TIPOS } from './tipos.js';

const MAX_LINEAS = 2000;
const MAX_CANTIDAD = 1000;
const MAX_CENTS = 10_000_000; // 100.000,00 €
const MAX_DETALLE = 200;
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
 * talla de un tramo en la que no viene nada) se ignoran. Cada línea tiene un
 * tipo (calzado, ropa…) y su talla debe ser de las que admite ese tipo; sin
 * tipo, una talla de número es calzado y lo demás accesorio.
 * @returns {{ tipo, subtipo_id, marca, modelo, referencia, color, talla, orden_talla, detalle, cantidad, coste_cent, pvp_cent }[]}
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
    const tipo = l?.tipo == null || l.tipo === '' ? tipoPorDefecto(l?.talla) : String(l.tipo);
    const subtipoId = l?.subtipo_id == null || l.subtipo_id === '' ? null : Number(l.subtipo_id);
    const marca = texto(l?.marca ?? marcaPorDefecto, 50);
    const referencia = texto(l?.referencia, 50);
    const modelo = texto(l?.modelo, 100) || referencia;
    const color = texto(l?.color, 50);
    const detalle = texto(l?.detalle, MAX_DETALLE);
    const cantidad = Number(l?.cantidad);
    const coste = centimos(l?.coste_cent);
    const pvp = centimos(l?.pvp_cent);
    if (!esTipo(tipo)) {
      errores.push(`línea ${n}: tipo de producto no válido`);
      return;
    }
    const talla = tallaParaTipo(l?.talla, tipo);
    if (subtipoId !== null && !idValido(subtipoId)) errores.push(`línea ${n}: subtipo no válido`);
    if (!marca) errores.push(`línea ${n}: falta la marca`);
    if (!referencia) errores.push(`línea ${n}: falta la referencia`);
    if (!color && TIPOS[tipo].color) errores.push(`línea ${n}: falta el color`);
    if (!talla.ok) errores.push(`línea ${n}: ${talla.error}`);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) errores.push(`línea ${n}: cantidad no válida`);
    if (!centValido(coste)) errores.push(`línea ${n}: coste no válido`);
    if (!centValido(pvp)) errores.push(`línea ${n}: PVP no válido`);
    if (!talla.ok) return;
    const key = [marca, modelo, referencia, color, talla.talla].join('|').toLowerCase();
    const previa = porSku.get(key);
    porSku.set(key, previa
      ? { ...previa, cantidad: previa.cantidad + cantidad, coste_cent: previa.coste_cent ?? coste, pvp_cent: previa.pvp_cent ?? pvp }
      : {
        tipo, subtipo_id: subtipoId, marca, modelo, referencia, color, talla: talla.talla, orden_talla: talla.orden, detalle,
        cantidad, coste_cent: coste, pvp_cent: pvp,
      });
  });
  if (errores.length) throw invalid(errores);
  return [...porSku.values()];
}

/* ---------- Artículos ---------- */

/** El subtipo debe existir y ser del mismo tipo que el artículo. */
async function comprobarSubtipo(db, subtipoId, tipo) {
  if (subtipoId == null) return;
  const row = (await db.query('SELECT type FROM product_subtypes WHERE id = $1', [subtipoId])).rows[0];
  if (!row || row.type !== tipo) throw invalid([`el subtipo no es de ${TIPOS[tipo].nombre.toLowerCase()}`]);
}

/**
 * Busca el SKU; si no existe lo crea con un EAN-13 nuevo. Actualiza coste y PVP
 * si vienen, y completa subtipo y detalle si el artículo aún no los tenía.
 */
export async function obtenerOCrearArticulo(db, l) {
  const sku = [l.marca, l.modelo, l.referencia, l.color, l.talla];
  await comprobarSubtipo(db, l.subtipo_id, l.tipo);
  const existente = (await db.query(
    `SELECT id, barcode FROM inventory_items
      WHERE lower(brand) = lower($1) AND lower(model) = lower($2) AND lower(reference) = lower($3)
        AND lower(color) = lower($4) AND lower(size) = lower($5) LIMIT 1`, sku)).rows[0];
  if (existente) {
    await db.query(`UPDATE inventory_items SET cost_cents = COALESCE($2, cost_cents), sale_price_cents = COALESCE($3, sale_price_cents),
      subtype_id = COALESCE(subtype_id, $4), detail = CASE WHEN detail = '' THEN $5 ELSE detail END, updated_at = NOW() WHERE id = $1`,
    [existente.id, l.coste_cent, l.pvp_cent, l.subtipo_id ?? null, l.detalle ?? '']);
    return { id: existente.id, codigo: existente.barcode, creado: false };
  }
  for (let intento = 0; intento < INTENTOS_CODIGO; intento += 1) {
    const codigo = nuevoCodigo();
    const libre = (await db.query('SELECT 1 FROM inventory_items WHERE barcode = $1', [codigo])).rowCount === 0;
    if (!libre) continue;
    const row = (await db.query(
      `INSERT INTO inventory_items (brand, model, reference, color, size, barcode, cost_cents, sale_price_cents, type, subtype_id, detail, size_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [...sku, codigo, l.coste_cent, l.pvp_cent, l.tipo, l.subtipo_id ?? null, l.detalle ?? '', l.orden_talla],
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
  await asegurarMarcas(db, lineas.map((l) => ({ marca: l.marca, tipo: l.tipo })), { proveedorId: doc.proveedor_id });
  return { lineas: lineas.length, unidades: lineas.reduce((s, l) => s + l.cantidad, 0), articulos_nuevos: nuevos, omitido: null };
}

const LINEA_COLUMNS = `
  i.id, i.doc_id, i.quantity, i.received_qty, i.state, i.received_at,
  a.id AS item_id, a.brand, a.model, a.reference, a.color, a.size, a.barcode, a.stock, a.sale_price_cents, a.cost_cents,
  a.type, a.subtype_id, a.detail, a.maker_barcode`;

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

export function articuloPublico(r) {
  return {
    id: r.id,
    tipo: r.type,
    subtipo_id: r.subtype_id,
    marca: r.brand,
    modelo: r.model,
    referencia: r.reference,
    color: r.color,
    talla: r.size,
    detalle: r.detail,
    codigo: r.barcode,
    codigo_fabricante: r.maker_barcode,
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
    WHERE i.doc_id = $1 ORDER BY a.reference, a.color, a.size_order, i.id`, [docId])).rows.map(lineaPublica);
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

/** Filtros: { q, tipo, estado: 'disponible' | 'pendiente' | 'faltas' | 'todos' }. */
export async function listarInventario(db, { q = '', tipo = '', estado = 'todos' } = {}) {
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(a.brand ILIKE $${params.length} OR a.model ILIKE $${params.length} OR a.reference ILIKE $${params.length}
      OR a.color ILIKE $${params.length} OR a.detail ILIKE $${params.length} OR a.barcode ILIKE $${params.length} OR a.maker_barcode ILIKE $${params.length})`);
  }
  if (tipo && esTipo(tipo)) {
    params.push(tipo);
    where.push(`a.type = $${params.length}`);
  }
  const having = { disponible: 'a.stock > 0', pendiente: 'pendiente > 0', faltas: 'faltan > 0' }[estado];
  const rows = (await db.query(`
    SELECT * FROM (
      SELECT a.*,
        COALESCE((SELECT sum(i.quantity) FROM inventory_incoming i WHERE i.item_id = a.id AND i.state = 'pendiente'), 0)::int AS pendiente,
        COALESCE((SELECT sum(i.quantity - i.received_qty) FROM inventory_incoming i WHERE i.item_id = a.id AND i.state = 'falta'), 0)::int AS faltan
      FROM inventory_items a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ) a ${having ? `WHERE ${having}` : ''}
    ORDER BY lower(a.brand), lower(a.model), a.reference, lower(a.color), a.size_order
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

/** Subtipos de producto, por tipo. */
export async function listarSubtipos(db) {
  const rows = (await db.query('SELECT id, type, name FROM product_subtypes ORDER BY type, name')).rows;
  return rows.map((r) => ({ id: r.id, tipo: r.type, nombre: r.name }));
}

/**
 * Cambia datos de un artículo: PVP, modelo, color, tipo, subtipo, detalle o
 * código de fábrica. Al cambiar de tipo, su talla debe valer para el nuevo.
 */
export async function actualizarArticulo(db, id, cambios) {
  const { pvp_cent: pvpIn, modelo, color, tipo: tipoIn, subtipo_id: subtipoIn, detalle, codigo_fabricante: fabricaIn } = cambios;
  const row = (await db.query('SELECT * FROM inventory_items WHERE id = $1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Artículo no encontrado.', 'ITEM_NOT_FOUND');
  const pvp = pvpIn === undefined ? row.sale_price_cents : centimos(pvpIn);
  if (!centValido(pvp)) throw invalid(['PVP no válido']);
  const tipo = tipoIn === undefined ? row.type : String(tipoIn);
  if (!esTipo(tipo)) throw invalid(['tipo de producto no válido']);
  if (tipo !== row.type) {
    const talla = tallaParaTipo(row.size, tipo);
    if (!talla.ok) throw invalid([talla.error]);
  }
  // Al cambiar de tipo, el subtipo anterior deja de valer si no se indica otro.
  const subtipo = subtipoIn === undefined ? (tipo === row.type ? row.subtype_id : null)
    : subtipoIn === null || subtipoIn === '' ? null : Number(subtipoIn);
  if (subtipo !== null && !idValido(subtipo)) throw invalid(['subtipo no válido']);
  await comprobarSubtipo(db, subtipo, tipo);
  const fabrica = fabricaIn === undefined ? row.maker_barcode : texto(fabricaIn, 20).replace(/\s/g, '') || null;
  if (fabrica !== null && !/^\d{8,14}$/.test(fabrica)) throw invalid(['el código de fábrica debe tener entre 8 y 14 cifras']);
  if (fabrica !== null && fabrica.length === 13 && !esEan13(fabrica)) throw invalid(['el código de fábrica no es un EAN-13 válido']);
  const after = {
    model: modelo === undefined ? row.model : texto(modelo, 100) || row.model,
    color: color === undefined ? row.color : texto(color, 50) || row.color,
    sale_price_cents: pvp,
    type: tipo,
    subtype_id: subtipo,
    detail: detalle === undefined ? row.detail : texto(detalle, MAX_DETALLE),
    maker_barcode: fabrica,
  };
  if (!after.color && TIPOS[tipo].color) throw invalid(['falta el color']);
  try {
    await db.query(`UPDATE inventory_items SET model = $2, color = $3, sale_price_cents = $4, type = $5, subtype_id = $6, detail = $7,
      maker_barcode = $8, updated_at = NOW() WHERE id = $1`,
    [id, after.model, after.color, after.sale_price_cents, after.type, after.subtype_id, after.detail, after.maker_barcode]);
  } catch (error) {
    if (error.code === '23505' && /maker_barcode/.test(error.constraint ?? '')) {
      throw new HttpError(409, 'Ese código de fábrica ya está en otro artículo.', 'MAKER_BARCODE_TAKEN');
    }
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
export async function etiquetasPara(db, { docId = null, lineas = null, articulo = null, copias = 1, lista = null }) {
  let rows;
  if (lista) {
    // Varios artículos sueltos con sus copias (lo dado de alta de una vez).
    if (!Array.isArray(lista) || lista.length > MAX_ETIQUETAS) throw invalid(['lista de artículos no válida']);
    const pedidas = lista.map((x) => ({ id: Number(x?.id), copias: Number(x?.copias) })).filter((x) => x.copias !== 0);
    if (pedidas.some((x) => !idValido(x.id) || !Number.isInteger(x.copias) || x.copias < 1 || x.copias > MAX_CANTIDAD)) throw invalid(['lista de artículos no válida']);
    if (pedidas.reduce((s, x) => s + x.copias, 0) > MAX_ETIQUETAS) throw invalid([`como mucho ${MAX_ETIQUETAS} etiquetas de una vez`]);
    const porId = new Map((await db.query('SELECT * FROM inventory_items WHERE id = ANY($1::int[])', [pedidas.map((x) => x.id)])).rows.map((a) => [a.id, a]));
    rows = pedidas.filter((x) => porId.has(x.id)).map((x) => ({ ...porId.get(x.id), unidades: x.copias }));
  } else if (articulo) {
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
      ORDER BY a.reference, a.color, a.size_order, i.id`, ids ? [docId, ids] : [docId])).rows;
  }
  const etiquetas = rows.flatMap((r) => Array.from({ length: r.unidades }, () => articuloPublico(r)));
  if (etiquetas.length > MAX_ETIQUETAS) throw invalid([`como mucho ${MAX_ETIQUETAS} etiquetas de una vez`]);
  return etiquetas;
}
