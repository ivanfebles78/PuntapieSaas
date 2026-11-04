// Garantías: cada producto devuelto como defectuoso abre una incidencia y
// queda en cuarentena (no se vende). Se le añaden fotos, se reclama al
// proveedor y se resuelve con su respuesta: abono, sustitución (las unidades
// nuevas vuelven al stock), reembolso, rechazo o «a_stock» si al final se
// puede vender. Lo que se hizo con el cliente ya quedó en la rectificativa:
// la respuesta del proveedor no cambia sus derechos.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { cleanFilename, validateUpload } from '../services/expense-files.js';

export const ESTADOS = Object.freeze(['abierta', 'reclamada', 'resuelta']);
export const RESOLUCIONES = Object.freeze({
  abono: 'Abono del proveedor',
  sustitucion: 'Sustitución (vuelve al stock)',
  reembolso: 'Reembolso del proveedor',
  rechazada: 'Rechazada por el proveedor',
  a_stock: 'Se puede vender (vuelve al stock)',
});
const VUELVEN_AL_STOCK = Object.freeze(['sustitucion', 'a_stock']);
const FILTROS = Object.freeze({ pendientes: "c.status <> 'resuelta'", resueltas: "c.status = 'resuelta'", todas: 'TRUE' });
const MAX_ARCHIVOS = 20;
const MAX_TEXTO = 300;
const TZ = 'Atlantic/Canary';

const noValida = (msg) => new HttpError(400, `Incidencia no válida: ${msg}.`, 'INVALID_WARRANTY');
const limpio = (v, max = MAX_TEXTO) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** El proveedor más probable de un artículo: el de su última recepción o, si no, el de su marca. */
export async function proveedorProbable(db, itemId) {
  if (!itemId) return null;
  const r = (await db.query(
    `SELECT d.supplier_id FROM inventory_incoming i JOIN supplier_docs d ON d.id = i.doc_id
      WHERE i.item_id = $1 ORDER BY i.id DESC LIMIT 1`, [itemId],
  )).rows[0];
  if (r) return r.supplier_id;
  const marca = (await db.query(
    `SELECT d.supplier_id FROM inventory_items a JOIN inventory_items b ON lower(b.brand) = lower(a.brand)
       JOIN inventory_incoming i ON i.item_id = b.id JOIN supplier_docs d ON d.id = i.doc_id
      WHERE a.id = $1 ORDER BY i.id DESC LIMIT 1`, [itemId],
  )).rows[0];
  return marca?.supplier_id ?? null;
}

/** Dentro de la transacción del cambio: una incidencia por cada línea defectuosa. */
export async function abrirIncidencias(client, { ticketId, lineas, usuario }) {
  const ids = [];
  for (const l of lineas) {
    const r = (await client.query(
      `INSERT INTO warranty_cases (return_line_id, ticket_id, item_id, supplier_id, description, size, quantity, credit_cents, defect, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [l.return_line_id, ticketId, l.item_id, await proveedorProbable(client, l.item_id), l.descripcion, l.talla, l.cantidad, l.credito, l.defecto, usuario.id],
    )).rows[0];
    ids.push(r.id);
  }
  return ids;
}

const SELECT = `
  SELECT c.*, s.name AS proveedor, t.number AS rectificativa, uc.name AS abrio, ur.name AS reclamo, us.name AS resolvio,
         to_char(c.created_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY') AS fecha,
         to_char(c.claimed_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY') AS fecha_reclamacion,
         to_char(c.resolved_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY') AS fecha_resolucion,
         ((NOW() AT TIME ZONE '${TZ}')::date - (c.created_at AT TIME ZONE '${TZ}')::date) AS dias,
         a.barcode AS codigo,
         (SELECT count(*)::int FROM warranty_files f WHERE f.case_id = c.id) AS archivos
    FROM warranty_cases c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    LEFT JOIN tpv_tickets t ON t.id = c.ticket_id
    LEFT JOIN inventory_items a ON a.id = c.item_id
    LEFT JOIN users uc ON uc.id = c.created_by
    LEFT JOIN users ur ON ur.id = c.claimed_by
    LEFT JOIN users us ON us.id = c.resolved_by`;

const incidencia = (r) => ({
  id: r.id, estado: r.status, fecha: r.fecha, dias: r.dias, abrio: r.abrio,
  descripcion: r.description, talla: r.size, cantidad: r.quantity, codigo: r.codigo, credito_cent: r.credit_cents,
  defecto: r.defect, rectificativa: r.rectificativa, proveedor_id: r.supplier_id, proveedor: r.proveedor,
  reclamacion: r.claimed_at ? { referencia: r.claim_ref, notas: r.claim_notes, fecha: r.fecha_reclamacion, quien: r.reclamo } : null,
  resolucion: r.resolution ? {
    tipo: r.resolution, texto: RESOLUCIONES[r.resolution], importe_cent: r.resolution_cents, notas: r.resolution_notes, fecha: r.fecha_resolucion, quien: r.resolvio,
  } : null,
  archivos: r.archivos,
});

/** Lista de incidencias (pendientes por defecto), con lo que hay en cuarentena y los proveedores para elegir. */
export async function listarIncidencias(db, { estado = 'pendientes' } = {}) {
  const filtro = FILTROS[estado] ?? FILTROS.pendientes;
  const rows = (await db.query(`${SELECT} WHERE ${filtro} ORDER BY c.status = 'resuelta', c.created_at DESC LIMIT 200`)).rows;
  const t = (await db.query(
    `SELECT count(*) FILTER (WHERE status = 'abierta')::int AS abiertas, count(*) FILTER (WHERE status = 'reclamada')::int AS reclamadas,
            COALESCE(sum(quantity) FILTER (WHERE status <> 'resuelta'), 0)::int AS en_cuarentena
       FROM warranty_cases`,
  )).rows[0];
  const proveedores = (await db.query('SELECT id, name FROM suppliers ORDER BY lower(name)')).rows.map((p) => ({ id: p.id, nombre: p.name }));
  return { items: rows.map(incidencia), totales: t, proveedores, resoluciones: RESOLUCIONES };
}

export async function obtenerIncidencia(db, id) {
  const r = (await db.query(`${SELECT} WHERE c.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Esa incidencia no existe.', 'WARRANTY_NOT_FOUND');
  const archivos = (await db.query(
    `SELECT f.id, f.filename, f.mime, f.size_bytes, u.name AS quien, to_char(f.uploaded_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS fecha
       FROM warranty_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.case_id = $1 ORDER BY f.id`, [id, TZ],
  )).rows;
  return { ...incidencia(r), archivos: archivos.map((f) => ({ id: f.id, nombre: f.filename, tipo: f.mime, bytes: f.size_bytes, quien: f.quien, fecha: f.fecha })) };
}

async function bloquear(client, id) {
  const c = (await client.query('SELECT * FROM warranty_cases WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!c) throw new HttpError(404, 'Esa incidencia no existe.', 'WARRANTY_NOT_FOUND');
  if (c.status === 'resuelta') throw new HttpError(409, 'Esa incidencia ya está resuelta.', 'WARRANTY_RESOLVED');
  return c;
}

async function leerProveedor(db, valor) {
  if (valor === null || valor === '') return null;
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) throw noValida('ese proveedor no existe');
  if (!(await db.query('SELECT 1 FROM suppliers WHERE id = $1', [id])).rowCount) throw noValida('ese proveedor no existe');
  return id;
}

/** Cambia el defecto descrito o el proveedor (mientras no esté resuelta). Devuelve antes/después para el log. */
export async function editarIncidencia(pool, id, cambios) {
  return withTransaction(pool, async (client) => {
    const c = await bloquear(client, id);
    const defecto = cambios.defecto === undefined ? c.defect : limpio(cambios.defecto);
    if (defecto.length < 3) throw noValida('escribe qué defecto tiene');
    const proveedor = cambios.proveedor_id === undefined ? c.supplier_id : await leerProveedor(client, cambios.proveedor_id);
    await client.query('UPDATE warranty_cases SET defect = $2, supplier_id = $3 WHERE id = $1', [id, defecto, proveedor]);
    return { antes: { defecto: c.defect, proveedor_id: c.supplier_id }, despues: { defecto, proveedor_id: proveedor } };
  });
}

/** Se ha reclamado al proveedor (con su referencia o número de RMA, si lo hay). */
export async function reclamarIncidencia(pool, id, { referencia, notas, proveedor_id: proveedorId }, usuario) {
  return withTransaction(pool, async (client) => {
    const c = await bloquear(client, id);
    const proveedor = proveedorId === undefined ? c.supplier_id : await leerProveedor(client, proveedorId);
    if (!proveedor) throw noValida('elige a qué proveedor se reclama');
    await client.query(
      `UPDATE warranty_cases SET status = 'reclamada', supplier_id = $2, claim_ref = $3, claim_notes = $4, claimed_at = NOW(), claimed_by = $5 WHERE id = $1`,
      [id, proveedor, limpio(referencia, 60) || null, limpio(notas) || null, usuario.id],
    );
  });
}

/**
 * Cierra la incidencia con la respuesta del proveedor. Con «sustitucion» o
 * «a_stock», las unidades vuelven al stock; con lo demás salen de la cuarentena.
 */
export async function resolverIncidencia(pool, id, { resolucion, importe_cent: importe, notas }, usuario) {
  if (!Object.hasOwn(RESOLUCIONES, resolucion)) throw noValida('elige cómo se ha resuelto');
  const conImporte = resolucion === 'abono' || resolucion === 'reembolso';
  const cents = importe == null || importe === '' ? null : Number(importe);
  if (cents !== null && (!Number.isInteger(cents) || cents < 0 || cents > 10_000_000)) throw noValida('el importe no es válido');
  if (conImporte && !cents) throw noValida('escribe el importe del abono o del reembolso');
  return withTransaction(pool, async (client) => {
    const c = await bloquear(client, id);
    await client.query(
      `UPDATE warranty_cases SET status = 'resuelta', resolution = $2, resolution_cents = $3, resolution_notes = $4, resolved_at = NOW(), resolved_by = $5 WHERE id = $1`,
      [id, resolucion, conImporte ? cents : null, limpio(notas) || null, usuario.id],
    );
    const alStock = VUELVEN_AL_STOCK.includes(resolucion) && c.item_id;
    if (alStock) await client.query('UPDATE inventory_items SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [c.item_id, c.quantity]);
    return { descripcion: c.description, al_stock: alStock ? c.quantity : 0 };
  });
}

/* ---------- Fotos y documentos ---------- */

export async function anadirArchivo(pool, id, { filename, mime, data, usuario }) {
  const tipo = validateUpload({ mime, data });
  return withTransaction(pool, async (client) => {
    await bloquear(client, id);
    const n = (await client.query('SELECT count(*)::int AS n FROM warranty_files WHERE case_id = $1', [id])).rows[0].n;
    if (n >= MAX_ARCHIVOS) throw new HttpError(409, `Como mucho ${MAX_ARCHIVOS} archivos por incidencia.`, 'TOO_MANY_FILES');
    const nombre = cleanFilename(filename);
    const r = (await client.query(
      'INSERT INTO warranty_files (case_id, filename, mime, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [id, nombre, tipo, data.length, data, usuario.id],
    )).rows[0];
    return { id: r.id, nombre };
  });
}

export async function leerArchivo(db, fileId) {
  const r = (await db.query('SELECT filename, mime, data FROM warranty_files WHERE id = $1', [fileId])).rows[0];
  if (!r) throw new HttpError(404, 'Ese archivo no existe.', 'FILE_NOT_FOUND');
  return r;
}

export async function borrarArchivo(pool, fileId) {
  return withTransaction(pool, async (client) => {
    const f = (await client.query('SELECT case_id, filename FROM warranty_files WHERE id = $1', [fileId])).rows[0];
    if (!f) throw new HttpError(404, 'Ese archivo no existe.', 'FILE_NOT_FOUND');
    await bloquear(client, f.case_id);
    await client.query('DELETE FROM warranty_files WHERE id = $1', [fileId]);
    return { incidencia: f.case_id, nombre: f.filename };
  });
}
