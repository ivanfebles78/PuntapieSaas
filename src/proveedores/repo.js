// Facturas y pedidos de proveedores sobre PostgreSQL. Porta los servicios de
// «Control de facturas» (FacturasPuntaPie) manteniendo su contrato: importes en
// céntimos enteros, fechas «YYYY-MM-DD» y los mismos nombres de campo, para que
// el cálculo de estado, la previsión y el calendario en PDF se usen tal cual.
import { HttpError } from '../http-error.js';
import { todayInShop } from '../services/vacation-balance.js';
import { calcularEstado, importePendiente } from './domain/estado.js';

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500;
const MAX_CENTS = 100_000_000; // 1.000.000,00 €
const MAX_ID = 2_147_483_647;
const ORPHAN_GRACE = "INTERVAL '10 minutes'";
const hoyTienda = () => todayInShop();

export class DuplicateError extends HttpError {
  constructor(message) {
    super(409, message, 'DUPLICADO');
  }
}

function invalid(errores) {
  return new HttpError(400, `Datos no válidos: ${errores.join('; ')}.`, 'INVALID_DOCUMENT');
}

/** Transacción; si `db` ya es un cliente en transacción, trabaja dentro de ella. */
export async function withTransaction(db, work) {
  if (typeof db.release === 'function') return work(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/* ---------- Validación ---------- */

function limpiar(v) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, MAX_TEXT);
  return s === '' ? null : s;
}

function listaTexto(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 50);
  if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 50);
  return [];
}

const fechaValida = (s) => RE_ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

const importeValido = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_CENTS;

/**
 * Normaliza y valida un documento (como validarDocumento del original). Los
 * pagos dentro de los vencimientos solo se aceptan con `allowPayments` (la
 * importación de la app antigua); por la API se pagan con «Pagar».
 */
export function validarDocumento(input, hoy = hoyTienda(), { allowPayments = false } = {}) {
  const errores = [];
  const tipo = input.tipo === 'pedido' ? 'pedido' : input.tipo === 'factura' ? 'factura' : null;
  if (!tipo) errores.push('el tipo debe ser «factura» o «pedido»');
  const numero = String(input.numero ?? '').trim().slice(0, 80);
  if (!numero) errores.push('el número es obligatorio');
  const fecha = input.fecha ? String(input.fecha) : null;
  if (fecha && !fechaValida(fecha)) errores.push('la fecha no es válida');
  const fechaEntrega = input.fecha_entrega ? String(input.fecha_entrega) : null;
  if (fechaEntrega && !fechaValida(fechaEntrega)) errores.push('la fecha de entrega no es válida');
  const total = Number(input.total_cent);
  if (!importeValido(total)) errores.push('el total no es válido');

  const proveedor = input.proveedor ?? {};
  const proveedorId = input.proveedor_id ? Number(input.proveedor_id) : null;
  if (proveedorId !== null && (!Number.isInteger(proveedorId) || proveedorId <= 0 || proveedorId > MAX_ID)) errores.push('proveedor no válido');
  if (!proveedorId && !String(proveedor.nombre ?? '').trim()) errores.push('falta el nombre del proveedor');

  const vencimientos = Array.isArray(input.vencimientos) ? input.vencimientos.slice(0, 60) : [];
  const vtos = vencimientos.map((v, i) => {
    const f = String(v.fecha ?? '');
    const imp = Number(v.importe_cent);
    if (!fechaValida(f)) errores.push(`vencimiento ${i + 1}: fecha no válida`);
    if (!importeValido(imp)) errores.push(`vencimiento ${i + 1}: importe no válido`);
    let pago = null;
    if (allowPayments && v.pago) {
      pago = { ...v.pago, importe_cent: Number(v.pago.importe_cent) };
      if (!fechaValida(String(pago.fecha ?? '')) || !importeValido(pago.importe_cent)) errores.push(`vencimiento ${i + 1}: pago no válido`);
    }
    return { fecha: f, importe_cent: imp, orden: i, pago };
  });
  if (tipo === 'pedido' && vtos.length > 0) errores.push('un pedido no puede tener vencimientos');
  if (errores.length) throw invalid(errores);

  // Una factura sin vencimientos se paga entera en su fecha (o al guardarse).
  if (tipo === 'factura' && vtos.length === 0) vtos.push({ fecha: fecha ?? hoy, importe_cent: total, orden: 0, pago: null });

  return {
    tipo,
    numero,
    fecha,
    total_cent: total,
    forma_pago: limpiar(input.forma_pago),
    fecha_entrega: fechaEntrega,
    pedidos: listaTexto(input.pedidos),
    albaranes: listaTexto(input.albaranes),
    notas: limpiar(input.notas),
    parser: limpiar(input.parser),
    confianza: limpiar(input.confianza),
    estado_manual: ['recibido', 'cancelado'].includes(input.estado_manual) ? input.estado_manual : null,
    proveedor_id: proveedorId,
    proveedor: { nombre: limpiar(proveedor.nombre), cif: normalizarCif(proveedor.cif) },
    vencimientos: vtos,
  };
}

export const normalizarCif = (cif) => (cif ? String(cif).toUpperCase().replace(/^ES/, '').replace(/[\s.-]/g, '').trim().slice(0, 20) || null : null);

export function normalizarRef(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9Ñ]/g, '').replace(/^0+(?=\d)/, '');
}

/* ---------- Proveedores ---------- */

export async function obtenerOCrearProveedor(db, { nombre, cif }) {
  const cifNorm = normalizarCif(cif);
  let row = null;
  if (cifNorm) row = (await db.query('SELECT * FROM suppliers WHERE cif = $1', [cifNorm])).rows[0];
  if (!row && nombre) row = (await db.query('SELECT * FROM suppliers WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [nombre.trim()])).rows[0];
  if (row) {
    if (cifNorm && !row.cif) await db.query('UPDATE suppliers SET cif = $2 WHERE id = $1', [row.id, cifNorm]);
    return { id: row.id, nombre: row.name, cif: row.cif ?? cifNorm };
  }
  const inserted = await db.query(
    'INSERT INTO suppliers (name, cif) VALUES ($1, $2) RETURNING id, name, cif',
    [(nombre ?? cifNorm ?? 'Proveedor').trim(), cifNorm],
  );
  return { id: inserted.rows[0].id, nombre: inserted.rows[0].name, cif: inserted.rows[0].cif };
}

export async function listarProveedores(db) {
  const result = await db.query(`
    SELECT s.id, s.name, s.cif, s.notes,
      (SELECT count(*)::int FROM supplier_docs d WHERE d.supplier_id = s.id AND d.kind = 'factura') AS facturas,
      (SELECT count(*)::int FROM supplier_docs d WHERE d.supplier_id = s.id AND d.kind = 'pedido') AS pedidos,
      (SELECT COALESCE(sum(d.total_cents), 0)::int FROM supplier_docs d WHERE d.supplier_id = s.id AND d.kind = 'factura') AS facturado_cent,
      (SELECT COALESCE(sum(du.amount_cents), 0)::int FROM supplier_dues du
         JOIN supplier_docs d ON d.id = du.doc_id LEFT JOIN supplier_payments p ON p.due_id = du.id
        WHERE d.supplier_id = s.id AND d.kind = 'factura' AND p.id IS NULL) AS pendiente_cent
    FROM suppliers s ORDER BY lower(s.name)`);
  return result.rows.map((r) => ({
    id: r.id, nombre: r.name, cif: r.cif, notas: r.notes,
    facturas: r.facturas, pedidos: r.pedidos, facturado_cent: r.facturado_cent, pendiente_cent: r.pendiente_cent,
  }));
}

export async function actualizarProveedor(db, id, { nombre, cif, notas }) {
  const row = (await db.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Proveedor no encontrado.', 'SUPPLIER_NOT_FOUND');
  const after = {
    name: nombre != null && String(nombre).trim() ? String(nombre).trim().slice(0, 120) : row.name,
    cif: cif === undefined ? row.cif : normalizarCif(cif),
    notes: notas === undefined ? row.notes : limpiar(notas),
  };
  if (after.cif && after.cif !== row.cif) {
    const taken = await db.query('SELECT 1 FROM suppliers WHERE cif = $1 AND id <> $2', [after.cif, id]);
    if (taken.rowCount) throw new HttpError(409, 'Ya hay otro proveedor con ese CIF.', 'CIF_TAKEN');
  }
  await db.query('UPDATE suppliers SET name = $2, cif = $3, notes = $4 WHERE id = $1', [id, after.name, after.cif, after.notes]);
  return {
    before: { nombre: row.name, cif: row.cif, notas: row.notes },
    after: { id, nombre: after.name, cif: after.cif, notas: after.notes },
  };
}

/* ---------- Archivos ---------- */

/** Guarda un archivo (ya validado) y devuelve su id. */
export async function guardarArchivo(db, { data, filename, mime, sha256 }) {
  const result = await db.query(
    'INSERT INTO supplier_files (filename, mime, size_bytes, sha256, data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [filename, mime, data.length, sha256, data],
  );
  return result.rows[0].id;
}

export async function leerArchivo(db, id) {
  const row = (await db.query('SELECT filename, mime, data FROM supplier_files WHERE id = $1', [id])).rows[0];
  if (!row) throw new HttpError(404, 'Ese archivo no existe.', 'FILE_NOT_FOUND');
  return row;
}

/** Borra los archivos que ya no usa ningún documento ni pago. */
export async function purgarHuerfanos(db) {
  // Margen de 10 minutos: un archivo recién subido aún no está enlazado.
  await db.query(`DELETE FROM supplier_files f
    WHERE f.created_at < NOW() - ${ORPHAN_GRACE}
      AND NOT EXISTS (SELECT 1 FROM supplier_docs d WHERE d.file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM supplier_payments p WHERE p.file_id = f.id)`);
}

/* ---------- Lectura ---------- */

const DOC_COLUMNS = `
  d.id, d.kind, d.supplier_id, d.number, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, d.total_cents,
  d.payment_terms, to_char(d.delivery_date, 'YYYY-MM-DD') AS delivery_date, d.orders, d.delivery_notes,
  d.file_id, f.filename AS file_name, d.file_hash, d.notes, d.parser, d.confidence, d.manual_state,
  d.created_at, d.updated_at, s.name AS supplier_name, s.cif AS supplier_cif`;

const DOC_FROM = `FROM supplier_docs d JOIN suppliers s ON s.id = d.supplier_id
  LEFT JOIN supplier_files f ON f.id = d.file_id`;

async function vencimientosDe(db, docIds) {
  if (docIds.length === 0) return new Map();
  const rows = (await db.query(`
    SELECT du.id, du.doc_id, to_char(du.due_date, 'YYYY-MM-DD') AS fecha, du.amount_cents, du.position,
           p.id AS pago_id, to_char(p.paid_on, 'YYYY-MM-DD') AS pago_fecha, p.amount_cents AS pago_importe,
           p.file_id AS pago_archivo, f.filename AS pago_archivo_nombre, p.notes AS pago_notas
      FROM supplier_dues du
      LEFT JOIN supplier_payments p ON p.due_id = du.id
      LEFT JOIN supplier_files f ON f.id = p.file_id
     WHERE du.doc_id = ANY($1::int[])
     ORDER BY du.due_date, du.position, du.id`, [docIds])).rows;
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.doc_id) ?? [];
    list.push({
      id: r.id,
      fecha: r.fecha,
      importe_cent: r.amount_cents,
      pago: r.pago_id ? {
        id: r.pago_id, fecha: r.pago_fecha, importe_cent: r.pago_importe,
        archivo: r.pago_archivo, archivo_nombre: r.pago_archivo_nombre, notas: r.pago_notas,
      } : null,
    });
    map.set(r.doc_id, list);
  }
  return map;
}

/** Documentos de esos proveedores, para enlazar facturas y pedidos por referencia. */
async function hermanos(db, supplierIds) {
  if (supplierIds.length === 0) return [];
  return (await db.query(`
    SELECT id, kind, supplier_id, number, to_char(doc_date, 'YYYY-MM-DD') AS fecha, total_cents,
           to_char(delivery_date, 'YYYY-MM-DD') AS fecha_entrega, orders
      FROM supplier_docs WHERE supplier_id = ANY($1::int[])`, [supplierIds])).rows;
}

function hidratar(row, vtos, otros, hoy) {
  const tipo = row.kind;
  const vencimientos = tipo === 'factura' ? vtos : [];
  const pedidos = row.orders ?? [];
  const delProveedor = otros.filter((o) => o.supplier_id === row.supplier_id);
  const facturasAsociadas = tipo === 'pedido'
    ? delProveedor.filter((o) => o.kind === 'factura' && (o.orders ?? []).some((p) => normalizarRef(p) === normalizarRef(row.number)))
      .map((o) => ({ id: o.id, numero: o.number, fecha: o.fecha, total_cent: o.total_cents }))
    : [];
  const refs = new Set(pedidos.map(normalizarRef));
  const pedidosAsociados = tipo === 'factura' && refs.size
    ? delProveedor.filter((o) => o.kind === 'pedido' && refs.has(normalizarRef(o.number)))
      .map((o) => ({ id: o.id, numero: o.number, fecha: o.fecha, total_cent: o.total_cents, fecha_entrega: o.fecha_entrega }))
    : [];
  const estado = calcularEstado({ tipo, estado_manual: row.manual_state }, vencimientos, { hoy, facturado: facturasAsociadas.length > 0 });
  const pendiente = tipo === 'factura' ? importePendiente(vencimientos) : 0;
  return {
    id: row.id,
    tipo,
    proveedor_id: row.supplier_id,
    numero: row.number,
    fecha: row.doc_date,
    total_cent: row.total_cents,
    forma_pago: row.payment_terms,
    fecha_entrega: row.delivery_date,
    pedidos,
    albaranes: row.delivery_notes ?? [],
    archivo: row.file_id,
    archivo_nombre: row.file_name,
    archivo_hash: row.file_hash,
    notas: row.notes,
    parser: row.parser,
    confianza: row.confidence,
    estado_manual: row.manual_state,
    creado_en: row.created_at,
    actualizado_en: row.updated_at,
    proveedor: { id: row.supplier_id, nombre: row.supplier_name, cif: row.supplier_cif },
    vencimientos,
    estado,
    pendiente_cent: pendiente,
    pagado_cent: tipo === 'factura' ? row.total_cents - pendiente : 0,
    proximo_vencimiento: vencimientos.find((v) => !v.pago)?.fecha ?? null,
    facturas_asociadas: facturasAsociadas,
    pedidos_asociados: pedidosAsociados,
  };
}

async function cargar(db, where, params, hoy) {
  const rows = (await db.query(`SELECT ${DOC_COLUMNS} ${DOC_FROM} ${where} ORDER BY d.doc_date DESC NULLS LAST, d.id DESC`, params)).rows;
  const vtos = await vencimientosDe(db, rows.filter((r) => r.kind === 'factura').map((r) => r.id));
  const otros = await hermanos(db, [...new Set(rows.map((r) => r.supplier_id))]);
  return rows.map((r) => hidratar(r, vtos.get(r.id) ?? [], otros, hoy));
}

export async function obtenerDocumento(db, id, hoy = hoyTienda()) {
  const [doc] = await cargar(db, 'WHERE d.id = $1', [id], hoy);
  if (!doc) throw new HttpError(404, 'Documento no encontrado.', 'DOC_NOT_FOUND');
  return doc;
}

/** Filtros: { tipo, proveedor_id, estado, q, desde, hasta } (como el original). */
export async function listarDocumentos(db, filtros = {}, hoy = hoyTienda()) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (filtros.tipo === 'factura' || filtros.tipo === 'pedido') add('d.kind = ?', filtros.tipo);
  if (filtros.proveedor_id && Number.isInteger(Number(filtros.proveedor_id)) && Number(filtros.proveedor_id) <= MAX_ID) add('d.supplier_id = ?', Number(filtros.proveedor_id));
  if (filtros.desde && fechaValida(filtros.desde)) add('d.doc_date >= ?', filtros.desde);
  if (filtros.hasta && fechaValida(filtros.hasta)) add('d.doc_date <= ?', filtros.hasta);
  if (filtros.q) {
    const like = `%${String(filtros.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add('(d.number ILIKE ? OR s.name ILIKE ? OR d.orders::text ILIKE ? OR d.delivery_notes::text ILIKE ? OR d.notes ILIKE ?)', like);
  }
  const docs = await cargar(db, where.length ? `WHERE ${where.join(' AND ')}` : '', params, hoy);
  return filtros.estado ? docs.filter((d) => d.estado === filtros.estado) : docs;
}

/** Facturas con algún vencimiento dentro de [desde, hasta] (para la tabla de Gastos). */
export async function facturasConVencimientosEntre(db, desde, hasta, hoy = hoyTienda()) {
  return cargar(db, `WHERE d.kind = 'factura' AND EXISTS (
    SELECT 1 FROM supplier_dues du WHERE du.doc_id = d.id AND du.due_date BETWEEN $1 AND $2)`, [desde, hasta], hoy);
}

/* ---------- Duplicados ---------- */

/**
 * Busca si un documento ya está importado, por orden de fiabilidad: mismo PDF
 * (SHA-256), mismo número del mismo proveedor, o misma fecha e importe.
 */
export async function buscarDuplicado(db, { hash, cif, nombre, tipo, numero, fecha, total_cent: total }) {
  const resultado = (row, motivo) => (row
    ? { id: row.id, tipo: row.kind, numero: row.number, fecha: row.doc_date, proveedor: row.supplier_name, motivo }
    : null);
  if (hash) {
    const row = (await db.query(`SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.file_hash = $1 LIMIT 1`, [hash])).rows[0];
    if (row) return resultado(row, 'archivo');
  }
  const proveedor = 'AND (s.cif = $3 OR lower(s.name) = lower($4))';
  const quien = [normalizarCif(cif) ?? '', nombre ?? ''];
  if (numero) {
    const row = (await db.query(`SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.kind = $1 AND d.number = $2 ${proveedor} LIMIT 1`, [tipo, numero, ...quien])).rows[0];
    if (row) return resultado(row, 'numero');
  }
  if (fecha && total != null) {
    const row = (await db.query(
      `SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.kind = $1 AND d.doc_date = $2 AND d.total_cents = $5 ${proveedor} LIMIT 1`,
      [tipo, fecha, ...quien, total],
    )).rows[0];
    if (row) return resultado(row, 'importe');
  }
  return null;
}

/* ---------- Escritura ---------- */

async function insertarVencimientos(db, docId, vencimientos, userId) {
  for (const [i, v] of vencimientos.entries()) {
    const due = await db.query(
      'INSERT INTO supplier_dues (doc_id, due_date, amount_cents, position) VALUES ($1, $2, $3, $4) RETURNING id',
      [docId, v.fecha, v.importe_cent, i],
    );
    if (v.pago) {
      await db.query(
        'INSERT INTO supplier_payments (due_id, paid_on, amount_cents, file_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [due.rows[0].id, v.pago.fecha, v.pago.importe_cent, v.pago.archivo ?? null, v.pago.notas ?? null, userId ?? null],
      );
    }
  }
}

/**
 * Crea un documento. `archivo` = { fileId, hash } del PDF ya guardado, o null.
 * Rechaza el mismo PDF dos veces y el mismo número del mismo proveedor.
 */
export async function crearDocumento(pool, input, archivo = null, { userId = null, legacyId = null } = {}) {
  const d = validarDocumento(input, undefined, { allowPayments: legacyId !== null });
  return withTransaction(pool, async (client) => {
    if (archivo?.hash) {
      const mismo = (await client.query('SELECT kind, number FROM supplier_docs WHERE file_hash = $1 LIMIT 1', [archivo.hash])).rows[0];
      if (mismo) throw new DuplicateError(`Este PDF ya está importado como ${mismo.kind} ${mismo.number}.`);
    }
    const proveedorId = d.proveedor_id ?? (await obtenerOCrearProveedor(client, d.proveedor)).id;
    const existe = await client.query(
      'SELECT 1 FROM supplier_docs WHERE supplier_id = $1 AND kind = $2 AND number = $3',
      [proveedorId, d.tipo, d.numero],
    );
    if (existe.rowCount) throw new DuplicateError(`Ya existe ${d.tipo} ${d.numero} de este proveedor.`);
    const inserted = await client.query(`
      INSERT INTO supplier_docs (kind, supplier_id, number, doc_date, total_cents, payment_terms, delivery_date, orders,
        delivery_notes, file_id, file_hash, notes, parser, confidence, manual_state, legacy_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
    [d.tipo, proveedorId, d.numero, d.fecha, d.total_cent, d.forma_pago, d.fecha_entrega, JSON.stringify(d.pedidos),
      JSON.stringify(d.albaranes), archivo?.fileId ?? null, archivo?.hash ?? null, d.notas, d.parser, d.confianza,
      d.estado_manual, legacyId, userId]);
    const id = inserted.rows[0].id;
    await insertarVencimientos(client, id, d.vencimientos, userId);
    return obtenerDocumento(client, id);
  });
}

/** Edita un documento. Conserva los pagos de los vencimientos con misma fecha e importe. */
export async function actualizarDocumento(pool, id, input) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT 1 FROM supplier_docs WHERE id = $1 FOR UPDATE', [id]);
    const actual = await obtenerDocumento(client, id);
    const d = validarDocumento({
      ...actual,
      proveedor_id: actual.proveedor_id,
      ...input,
      vencimientos: input.vencimientos ?? actual.vencimientos.map((v) => ({ fecha: v.fecha, importe_cent: v.importe_cent })),
    });
    const proveedorId = input.proveedor_id ? Number(input.proveedor_id)
      : input.proveedor?.nombre ? (await obtenerOCrearProveedor(client, d.proveedor)).id : actual.proveedor_id;
    const choque = await client.query(
      'SELECT 1 FROM supplier_docs WHERE supplier_id = $1 AND kind = $2 AND number = $3 AND id <> $4',
      [proveedorId, d.tipo, d.numero, id],
    );
    if (choque.rowCount) throw new DuplicateError(`Ya existe ${d.tipo} ${d.numero} de este proveedor.`);
    await client.query(`
      UPDATE supplier_docs SET kind = $2, supplier_id = $3, number = $4, doc_date = $5, total_cents = $6, payment_terms = $7,
        delivery_date = $8, orders = $9, delivery_notes = $10, notes = $11, manual_state = $12, updated_at = NOW()
      WHERE id = $1`,
    [id, d.tipo, proveedorId, d.numero, d.fecha, d.total_cent, d.forma_pago, d.fecha_entrega,
      JSON.stringify(d.pedidos), JSON.stringify(d.albaranes), d.notas, d.estado_manual]);

    if (input.vencimientos !== undefined || d.tipo === 'pedido' || actual.tipo !== d.tipo) {
      const conPago = actual.vencimientos.filter((v) => v.pago);
      const usados = new Set();
      const nuevos = (d.tipo === 'pedido' ? [] : d.vencimientos).map((v) => {
        const match = conPago.find((p) => p.fecha === v.fecha && p.importe_cent === v.importe_cent && !usados.has(p.id));
        if (match) usados.add(match.id);
        return { ...v, pago: match?.pago ?? null };
      });
      // Un vencimiento pagado no desaparece sin querer: primero se anula su pago.
      const perdidos = conPago.filter((p) => !usados.has(p.id));
      if (perdidos.length) {
        const lista = perdidos.map((p) => `${p.fecha.split('-').reverse().join('/')} (${(p.importe_cent / 100).toFixed(2).replace('.', ',')} €)`).join(', ');
        throw new HttpError(409, `El vencimiento ${lista} ya está pagado: anula antes su pago para cambiarlo.`, 'PAID_DUE_CHANGED');
      }
      await client.query('DELETE FROM supplier_dues WHERE doc_id = $1', [id]);
      await insertarVencimientos(client, id, nuevos);
      await purgarHuerfanos(client);
    }
    return { before: actual, after: await obtenerDocumento(client, id) };
  });
}

export async function eliminarDocumento(pool, id) {
  return withTransaction(pool, async (client) => {
    const doc = await obtenerDocumento(client, id);
    await client.query('DELETE FROM supplier_docs WHERE id = $1', [id]);
    await purgarHuerfanos(client);
    return doc;
  });
}

export async function sustituirArchivo(pool, id, archivo) {
  return withTransaction(pool, async (client) => {
    const before = await obtenerDocumento(client, id);
    await client.query('UPDATE supplier_docs SET file_id = $2, file_hash = $3, updated_at = NOW() WHERE id = $1', [id, archivo.fileId, archivo.hash]);
    await purgarHuerfanos(client);
    return { before, after: await obtenerDocumento(client, id) };
  });
}

/** Asocia factura y pedido del mismo proveedor (añade el número del pedido a la factura). */
export async function asociarDocumentos(pool, idA, idB) {
  const a = await obtenerDocumento(pool, idA);
  const b = await obtenerDocumento(pool, idB);
  const factura = [a, b].find((d) => d.tipo === 'factura');
  const pedido = [a, b].find((d) => d.tipo === 'pedido');
  if (!factura || !pedido) throw new HttpError(400, 'Hay que asociar una factura con un pedido.', 'INVALID_LINK');
  if (factura.proveedor_id !== pedido.proveedor_id) throw new HttpError(400, 'La factura y el pedido son de proveedores distintos.', 'INVALID_LINK');
  if (!factura.pedidos.some((r) => normalizarRef(r) === normalizarRef(pedido.numero))) {
    await pool.query('UPDATE supplier_docs SET orders = $2, updated_at = NOW() WHERE id = $1', [factura.id, JSON.stringify([...factura.pedidos, pedido.numero])]);
  }
  return { factura: await obtenerDocumento(pool, factura.id), pedido };
}

export async function desasociarDocumentos(pool, facturaId, pedidoId) {
  const factura = await obtenerDocumento(pool, facturaId);
  const pedido = await obtenerDocumento(pool, pedidoId);
  if (factura.tipo !== 'factura' || pedido.tipo !== 'pedido') throw new HttpError(404, 'Documento no encontrado.', 'DOC_NOT_FOUND');
  const refs = factura.pedidos.filter((r) => normalizarRef(r) !== normalizarRef(pedido.numero));
  await pool.query('UPDATE supplier_docs SET orders = $2, updated_at = NOW() WHERE id = $1', [factura.id, JSON.stringify(refs)]);
  return { factura: await obtenerDocumento(pool, factura.id), pedido };
}

/* ---------- Pagos ---------- */

/** Paga un vencimiento concreto o todos los pendientes de la factura. */
export async function registrarPago(pool, docId, { vencimiento_id: vencimientoId = null, fecha, notas = null }, fileId = null, userId = null) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT 1 FROM supplier_docs WHERE id = $1 FOR UPDATE', [docId]);
    const doc = await obtenerDocumento(client, docId);
    if (doc.tipo !== 'factura') throw new HttpError(400, 'Solo se pueden pagar facturas.', 'NOT_INVOICE');
    if (fecha && !fechaValida(String(fecha))) throw new HttpError(400, 'La fecha de pago no es válida.', 'INVALID_DATE');
    const f = fecha ? String(fecha) : hoyTienda();
    const pendientes = doc.vencimientos.filter((v) => !v.pago);
    const objetivo = vencimientoId ? pendientes.filter((v) => v.id === Number(vencimientoId)) : pendientes;
    if (objetivo.length === 0) throw new HttpError(409, 'No hay vencimientos pendientes que pagar.', 'NOTHING_TO_PAY');
    for (const v of objetivo) {
      await client.query(
        'INSERT INTO supplier_payments (due_id, paid_on, amount_cents, file_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [v.id, f, v.importe_cent, fileId, limpiar(notas), userId],
      );
    }
    return { doc: await obtenerDocumento(client, docId), pagados: objetivo, fecha: f };
  });
}

export async function eliminarPago(pool, pagoId) {
  return withTransaction(pool, async (client) => {
    const row = (await client.query(
      `SELECT p.id, du.doc_id, to_char(p.paid_on, 'YYYY-MM-DD') AS fecha, p.amount_cents, to_char(du.due_date, 'YYYY-MM-DD') AS vence
         FROM supplier_payments p JOIN supplier_dues du ON du.id = p.due_id WHERE p.id = $1`, [pagoId])).rows[0];
    if (!row) throw new HttpError(404, 'Pago no encontrado.', 'PAYMENT_NOT_FOUND');
    await client.query('DELETE FROM supplier_payments WHERE id = $1', [pagoId]);
    await purgarHuerfanos(client);
    return { doc: await obtenerDocumento(client, row.doc_id), pago: row };
  });
}

export async function docDePago(db, pagoId) {
  const row = (await db.query('SELECT du.doc_id, p.file_id FROM supplier_payments p JOIN supplier_dues du ON du.id = p.due_id WHERE p.id = $1', [pagoId])).rows[0];
  if (!row) throw new HttpError(404, 'Pago no encontrado.', 'PAYMENT_NOT_FOUND');
  return row;
}

/** Justificante para un pago concreto (sustituye el anterior). */
export async function adjuntarJustificantePago(pool, pagoId, fileId) {
  return withTransaction(pool, async (client) => {
    const { doc_id: docId } = await docDePago(client, pagoId);
    await client.query('UPDATE supplier_payments SET file_id = $2 WHERE id = $1', [pagoId, fileId]);
    await purgarHuerfanos(client);
    return obtenerDocumento(client, docId);
  });
}

/**
 * Justificante a nivel de factura: va a los pagos sin justificante (o a todos
 * si ya lo tenían). La factura debe tener algún pago.
 */
export async function adjuntarJustificanteDocumento(pool, docId, fileId) {
  return withTransaction(pool, async (client) => {
    const doc = await obtenerDocumento(client, docId);
    const pagos = doc.vencimientos.filter((v) => v.pago).map((v) => v.pago);
    if (pagos.length === 0) {
      throw new HttpError(409, 'La factura no tiene ningún pago: usa «Pagar» para registrarlo con su justificante.', 'NO_PAYMENTS');
    }
    const sinArchivo = pagos.filter((p) => !p.archivo);
    const objetivo = sinArchivo.length ? sinArchivo : pagos;
    await client.query('UPDATE supplier_payments SET file_id = $2 WHERE id = ANY($1::int[])', [objetivo.map((p) => p.id), fileId]);
    await purgarHuerfanos(client);
    return obtenerDocumento(client, docId);
  });
}

/* ---------- Previsión, calendario y resumen ---------- */

export async function vencimientosPendientes(db) {
  return (await db.query(`
    SELECT du.id, to_char(du.due_date, 'YYYY-MM-DD') AS fecha, du.amount_cents AS importe_cent, d.id AS documento_id,
           d.number AS numero, to_char(d.doc_date, 'YYYY-MM-DD') AS documento_fecha, d.total_cents AS total_cent,
           s.id AS proveedor_id, s.name AS proveedor_nombre
      FROM supplier_dues du
      JOIN supplier_docs d ON d.id = du.doc_id
      JOIN suppliers s ON s.id = d.supplier_id
      LEFT JOIN supplier_payments p ON p.due_id = du.id
     WHERE d.kind = 'factura' AND p.id IS NULL
     ORDER BY du.due_date, du.id`)).rows;
}

export async function vencimientosParaCalendario(db, { desde, hasta }) {
  return (await db.query(`
    SELECT du.id, to_char(du.due_date, 'YYYY-MM-DD') AS fecha, du.amount_cents AS importe_cent, d.id AS documento_id,
           d.number AS numero, to_char(d.doc_date, 'YYYY-MM-DD') AS documento_fecha, s.name AS proveedor_nombre,
           (p.id IS NOT NULL) AS pagado
      FROM supplier_dues du
      JOIN supplier_docs d ON d.id = du.doc_id
      JOIN suppliers s ON s.id = d.supplier_id
      LEFT JOIN supplier_payments p ON p.due_id = du.id
     WHERE d.kind = 'factura' AND (du.due_date BETWEEN $1 AND $2 OR (p.id IS NULL AND du.due_date < $1))
     ORDER BY du.due_date, s.name`, [desde, hasta])).rows;
}

export async function resumen(db, hoy = hoyTienda()) {
  const facturas = await listarDocumentos(db, { tipo: 'factura' }, hoy);
  const pedidos = await listarDocumentos(db, { tipo: 'pedido' }, hoy);
  const cuenta = (arr, estado) => arr.filter((d) => d.estado === estado).length;
  return {
    facturas: facturas.length,
    pedidos: pedidos.length,
    pendiente_cent: facturas.reduce((s, d) => s + d.pendiente_cent, 0),
    pagado_cent: facturas.reduce((s, d) => s + d.pagado_cent, 0),
    facturado_cent: facturas.reduce((s, d) => s + d.total_cent, 0),
    vencido_cent: facturas.filter((d) => d.estado === 'vencida')
      .reduce((s, d) => s + d.vencimientos.filter((v) => !v.pago && v.fecha < hoy).reduce((t, v) => t + v.importe_cent, 0), 0),
    por_estado: {
      pendiente: cuenta(facturas, 'pendiente'),
      parcial: cuenta(facturas, 'parcial'),
      vencida: cuenta(facturas, 'vencida'),
      pagada: cuenta(facturas, 'pagada'),
    },
    pedidos_abiertos: pedidos.filter((d) => d.estado === 'pendiente').length,
  };
}
