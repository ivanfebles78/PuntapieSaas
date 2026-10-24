// Importa el ZIP exportado de «Control de facturas» (datos/datos.json + archivos/).
// Es idempotente: cada documento recuerda su id antiguo (legacy_id) y no se
// vuelve a crear; si se corta a medias, basta con subir el ZIP otra vez.
import JSZip from 'jszip';
import { HttpError } from '../http-error.js';
import { validateUpload } from '../services/expense-files.js';
import { hashBuffer, limpiarPdf } from './analisis.js';

export { limpiarPdf };
import { crearDocumento, DuplicateError, guardarArchivo, normalizarCif, purgarHuerfanos, resumen } from './repo.js';

const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MIME_BY_EXT = Object.freeze({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

function entrySize(entry) {
  // eslint-disable-next-line no-underscore-dangle
  return entry?._data?.uncompressedSize ?? 0;
}

async function leerJson(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  if (entrySize(entry) > MAX_ENTRY_BYTES) throw new HttpError(413, `${path} es demasiado grande.`, 'ZIP_TOO_BIG');
  try {
    return JSON.parse(await entry.async('string'));
  } catch {
    throw new HttpError(400, `${path} no es un JSON válido.`, 'INVALID_BACKUP');
  }
}

/** Abre el ZIP y comprueba que es la exportación esperada y que no es desproporcionado. */
export async function abrirZip(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new HttpError(400, 'El archivo no es un ZIP válido.', 'INVALID_ZIP');
  }
  // Solo se leen datos/datos.json, datos/resumen.json y archivos/: el resto
  // (copia-completa.json, frontend…) se ignora aunque sea grande.
  const used = Object.values(zip.files).filter((f) => !f.dir && (f.name.startsWith('archivos/') || f.name.startsWith('datos/') && !f.name.includes('/', 6)));
  const total = used.filter((f) => f.name !== 'datos/copia-completa.json').reduce((t, f) => t + entrySize(f), 0);
  if (total > MAX_TOTAL_BYTES) throw new HttpError(413, 'El ZIP es demasiado grande.', 'ZIP_TOO_BIG');
  const datos = await leerJson(zip, 'datos/datos.json');
  if (!datos || !Array.isArray(datos.documentos) || !Array.isArray(datos.proveedores)) {
    throw new HttpError(400, 'No es la exportación de «Control de facturas»: falta datos/datos.json.', 'INVALID_BACKUP');
  }
  return { zip, datos, esperado: await leerJson(zip, 'datos/resumen.json') };
}

/** Archivo del ZIP → id en supplier_files (reutiliza el mismo si lo comparten varios pagos). */
function archivero(db, zip, cuenta) {
  const cache = new Map();
  return async (path, nombre) => {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path);
    const entry = zip.file(path);
    if (!entry) return null;
    if (entrySize(entry) > MAX_ENTRY_BYTES) throw new HttpError(413, `${path} es demasiado grande.`, 'ZIP_TOO_BIG');
    const raw = await entry.async('nodebuffer');
    const mime = MIME_BY_EXT[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
    const { data, reparado } = mime === 'application/pdf' ? limpiarPdf(raw) : { data: raw, reparado: false };
    if (reparado) cuenta.reparados.push(nombre ?? path.split('/').pop());
    validateUpload({ mime, data });
    const file = { fileId: await guardarArchivo(db, { data, filename: nombre ?? path.split('/').pop(), mime, sha256: hashBuffer(data) }), hash: hashBuffer(data) };
    cache.set(path, file);
    return file;
  };
}

async function proveedorPara(db, p) {
  const byLegacy = (await db.query('SELECT id FROM suppliers WHERE legacy_id = $1', [p.id])).rows[0];
  if (byLegacy) return byLegacy.id;
  const cif = normalizarCif(p.cif);
  const existing = cif
    ? (await db.query('SELECT id FROM suppliers WHERE cif = $1', [cif])).rows[0]
    : (await db.query('SELECT id FROM suppliers WHERE lower(name) = lower($1) LIMIT 1', [p.nombre])).rows[0];
  if (existing) {
    await db.query('UPDATE suppliers SET legacy_id = COALESCE(legacy_id, $2) WHERE id = $1', [existing.id, p.id]);
    return existing.id;
  }
  const inserted = await db.query(
    'INSERT INTO suppliers (name, cif, notes, legacy_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [p.nombre, cif, p.notas ?? null, p.id],
  );
  return inserted.rows[0].id;
}

/**
 * Importa proveedores, facturas, pedidos, vencimientos, pagos y archivos.
 * Devuelve lo creado, lo que ya estaba y si los totales cuadran con resumen.json.
 */
export async function importarZip(pool, buffer, { userId }) {
  const { zip, datos, esperado } = await abrirZip(buffer);
  const cuenta = { facturas: 0, pedidos: 0, vencimientos: 0, pagos: 0, archivos: 0, yaEstaban: 0, duplicados: [], reparados: [] };
  const archivo = archivero(pool, zip, cuenta);
  const proveedores = new Map();
  for (const p of datos.proveedores) proveedores.set(p.id, await proveedorPara(pool, p));

  for (const d of datos.documentos) {
    const ya = await pool.query('SELECT 1 FROM supplier_docs WHERE legacy_id = $1', [d.id]);
    if (ya.rowCount) {
      cuenta.yaEstaban += 1;
      continue;
    }
    const pdf = await archivo(d.pdf, d.archivo_nombre);
    const vencimientos = [];
    for (const v of d.vencimientos ?? []) {
      const just = v.pago?.justificante ? await archivo(v.pago.justificante, v.pago.archivo_nombre) : null;
      vencimientos.push({
        fecha: v.fecha,
        importe_cent: v.importe_cent,
        pago: v.pago ? { fecha: v.pago.fecha, importe_cent: v.pago.importe_cent, archivo: just?.fileId ?? null, notas: v.pago.notas ?? null } : null,
      });
    }
    try {
      await crearDocumento(pool, {
        tipo: d.tipo,
        proveedor_id: proveedores.get(d.proveedor_id) ?? null,
        proveedor: d.proveedor,
        numero: d.numero,
        fecha: d.fecha,
        total_cent: d.total_cent,
        forma_pago: d.forma_pago,
        fecha_entrega: d.fecha_entrega,
        pedidos: d.pedidos,
        albaranes: d.albaranes,
        notas: d.notas,
        parser: d.parser,
        confianza: d.confianza,
        estado_manual: d.estado_manual,
        vencimientos,
      }, pdf ? { fileId: pdf.fileId, hash: d.archivo_hash ?? pdf.hash } : null, { userId, legacyId: d.id });
    } catch (error) {
      // Ya estaba (metido a mano o con «Importar PDF»): no se duplica.
      if (!(error instanceof DuplicateError)) throw error;
      cuenta.duplicados.push(`${d.tipo} ${d.numero} (${d.proveedor?.nombre ?? ''}): ${error.message}`);
      continue;
    }
    cuenta[d.tipo === 'pedido' ? 'pedidos' : 'facturas'] += 1;
    cuenta.vencimientos += vencimientos.length;
    cuenta.pagos += vencimientos.filter((v) => v.pago).length;
  }
  await purgarHuerfanos(pool);
  cuenta.archivos = (await pool.query('SELECT count(*)::int AS n FROM supplier_files')).rows[0].n;

  const ahora = await resumen(pool, datos.hoy ?? undefined);
  const claves = ['facturas', 'pedidos', 'pendiente_cent', 'pagado_cent', 'facturado_cent', 'vencido_cent'];
  return {
    ...cuenta,
    proveedores: proveedores.size,
    resumen: ahora,
    esperado,
    cuadra: esperado ? claves.every((k) => esperado[k] === ahora[k]) : null,
  };
}
