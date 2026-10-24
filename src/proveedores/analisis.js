// «Importar PDF»: extrae el texto, aplica el lector del proveedor (o la IA, si
// está configurada) y comprueba duplicados. El PDF espera en supplier_uploads
// hasta que se confirma el documento (o se descarta; a las 24 h se borra solo).
import crypto from 'node:crypto';
import { HttpError } from '../http-error.js';
import { cleanFilename, validateUpload } from '../services/expense-files.js';
import { extraerConIA } from './extract/ai.js';
import { extractPdfText } from './extract/pdfText.js';
import { detectParser, parseDocumento, PARSERS, vacio } from './parsers/index.js';
import { buscarDuplicado, guardarArchivo } from './repo.js';

const TEMP_TTL_HOURS = 24;
const TEXT_PREVIEW_CHARS = 4000;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_SETTINGS = Object.freeze({ cifsPropios: ['B76766294'], ai: { apiKey: '', model: '', mode: 'off' } });

const PDF_SIGNATURE = '%PDF-';
const PDF_END = '%%EOF';
const MAX_PDF_PREFIX = 1024;

/**
 * Algunos PDF llegan «envueltos» (descargas guardadas tal cual, justificantes del banco): con la cabecera HTTP
 * de la descarga o dentro de un sobre MIME (justificantes del banco). Si el
 * PDF empieza en los primeros 1.024 bytes, se recorta hasta su %%EOF.
 * Devuelve { data, reparado }.
 */
export function limpiarPdf(data) {
  const start = data.indexOf(PDF_SIGNATURE);
  if (start <= 0 || start > MAX_PDF_PREFIX) return { data, reparado: false };
  const end = data.lastIndexOf(PDF_END);
  return { data: data.subarray(start, end > start ? end + PDF_END.length : data.length), reparado: true };
}

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Lo que el navegador necesita saber: lectores disponibles y si hay IA. */
export function configPublica(settings = DEFAULT_SETTINGS) {
  return {
    parsers: PARSERS.map((p) => ({ id: p.id, nombre: p.nombre })),
    ia: Boolean(settings.ai.apiKey) && settings.ai.mode !== 'off',
  };
}

/** La IA manda sobre el genérico, pero se conserva lo que el genérico tenía si la IA no lo aporta. */
function fusionar(base, ia) {
  return {
    ...base,
    ...ia,
    proveedor: { nombre: ia.proveedor.nombre ?? base.proveedor.nombre, cif: ia.proveedor.cif ?? base.proveedor.cif },
    numero: ia.numero ?? base.numero,
    fecha: ia.fecha ?? base.fecha,
    total_cent: ia.total_cent ?? base.total_cent,
    vencimientos: ia.vencimientos.length ? ia.vencimientos : base.vencimientos,
    pedidos: ia.pedidos.length ? ia.pedidos : base.pedidos,
    albaranes: ia.albaranes.length ? ia.albaranes : base.albaranes,
    fecha_entrega: ia.fecha_entrega ?? base.fecha_entrega,
    forma_pago: ia.forma_pago ?? base.forma_pago,
    avisos: ia.avisos,
  };
}

/** Extrae los datos de un PDF ya validado (sin tocar la base de datos). */
export async function extraer(buffer, settings = DEFAULT_SETTINGS) {
  let pdfText;
  try {
    pdfText = await extractPdfText(buffer);
  } catch (error) {
    return { extraido: { ...vacio('ninguno'), confianza: 'baja', avisos: [`No se pudo leer el PDF: ${error.message}`] }, texto: '' };
  }
  let extraido = parseDocumento(pdfText, { cifsPropios: settings.cifsPropios });
  const sinTexto = pdfText.text.trim().length < 20;
  if (sinTexto) {
    extraido = { ...extraido, avisos: ['El PDF no contiene texto (puede ser un escaneo). Rellena los datos a mano.', ...extraido.avisos] };
  }
  const { ai } = settings;
  const usarIA = ai.apiKey && !sinTexto && (ai.mode === 'always' || (ai.mode === 'auto' && detectParser(pdfText.text).id === 'generico'));
  if (usarIA) {
    try {
      extraido = fusionar(extraido, await extraerConIA(pdfText.text, { apiKey: ai.apiKey, model: ai.model, cifsPropios: settings.cifsPropios }));
    } catch (error) {
      extraido = { ...extraido, avisos: [...extraido.avisos, `La extracción con IA falló: ${error.message}`] };
    }
  }
  return { extraido, texto: pdfText.text.slice(0, TEXT_PREVIEW_CHARS) };
}

/** Analiza un PDF subido y lo deja pendiente de confirmar. */
export async function analizarPdf(pool, { data: raw, filename, mime }, { userId, settings = DEFAULT_SETTINGS }) {
  // El hash es el del archivo tal cual: así se reconoce si se vuelve a subir el mismo.
  const hash = hashBuffer(raw);
  const { data } = limpiarPdf(raw);
  const type = validateUpload({ mime, data });
  if (type !== 'application/pdf') throw new HttpError(415, 'Solo se admiten PDF.', 'INVALID_FILE_TYPE');
  const nombre = cleanFilename(filename);
  const tempId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO supplier_uploads (temp_id, filename, sha256, data, created_by) VALUES ($1, $2, $3, $4, $5)',
    [tempId, nombre, hash, data, userId],
  );
  const { extraido, texto } = await extraer(data, settings);
  const duplicado = await buscarDuplicado(pool, {
    hash,
    cif: extraido.proveedor.cif,
    nombre: extraido.proveedor.nombre,
    tipo: extraido.tipo,
    numero: extraido.numero,
    fecha: extraido.fecha,
    total_cent: extraido.total_cent,
  });
  return { tempId, hash, archivo_nombre: nombre, extraido, duplicado, texto };
}

/** Pasa el PDF temporal a archivo definitivo. Devuelve { fileId, hash, nombre } o null. */
export async function consolidarArchivo(db, tempId, userId) {
  if (!tempId) return null;
  if (!RE_UUID.test(String(tempId))) throw new HttpError(400, 'Archivo temporal no válido.', 'INVALID_TEMP');
  const row = (await db.query(
    'DELETE FROM supplier_uploads WHERE temp_id = $1 AND created_by = $2 RETURNING filename, sha256, data',
    [tempId, userId],
  )).rows[0];
  if (!row) throw new HttpError(410, 'El PDF analizado ya no está disponible: vuelve a subirlo.', 'TEMP_GONE');
  const fileId = await guardarArchivo(db, { data: row.data, filename: row.filename, mime: 'application/pdf', sha256: row.sha256 });
  return { fileId, hash: row.sha256, nombre: row.filename };
}

export async function descartarTemporal(db, tempId, userId) {
  if (!RE_UUID.test(String(tempId))) return;
  await db.query('DELETE FROM supplier_uploads WHERE temp_id = $1 AND created_by = $2', [tempId, userId]);
}

export async function limpiarTemporales(db, hours = TEMP_TTL_HOURS) {
  await db.query(`DELETE FROM supplier_uploads WHERE created_at < NOW() - make_interval(hours => $1)`, [hours]);
}

/** Guarda un PDF o imagen subido (factura sustituida o justificante). */
export async function guardarSubida(db, { data: raw, filename, mime }, { soloPdf = false } = {}) {
  const { data } = String(mime ?? '').startsWith('application/pdf') ? limpiarPdf(raw) : { data: raw };
  const type = validateUpload({ mime, data });
  if (soloPdf && type !== 'application/pdf') throw new HttpError(415, 'La factura debe ser un PDF.', 'INVALID_FILE_TYPE');
  // El hash del documento es el del archivo tal cual, como en «Importar PDF»,
  // para que el aviso de duplicado reconozca el mismo archivo si se vuelve a subir.
  const fileId = await guardarArchivo(db, { data, filename: cleanFilename(filename), mime: type, sha256: hashBuffer(data) });
  return { fileId, hash: hashBuffer(raw) };
}
