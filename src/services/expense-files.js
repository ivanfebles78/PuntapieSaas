import { HttpError } from '../http-error.js';
import { ensureEntry, findActive } from './expenses.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_ENTRY = 20;
const MAX_FILENAME_LENGTH = 120;
export const FILE_KINDS = Object.freeze(['factura', 'justificante']);

// Solo PDF e imágenes, comprobando también la firma del contenido.
const ALLOWED = Object.freeze({
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
});

export function readFileKind(value) {
  if (!FILE_KINDS.includes(value)) {
    throw new HttpError(400, 'El documento debe ser «factura» o «justificante».', 'INVALID_FILE_KIND');
  }
  return value;
}

/** Nombre seguro para guardar y mostrar: sin rutas ni caracteres de control. */
export function cleanFilename(raw) {
  let name = '';
  try {
    name = decodeURIComponent(String(raw ?? ''));
  } catch {
    name = String(raw ?? '');
  }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (name || 'documento').slice(-MAX_FILENAME_LENGTH);
}

export function validateUpload({ mime, data }) {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  const check = ALLOWED[type];
  if (!check) throw new HttpError(415, 'Solo se admiten PDF o imágenes (JPG, PNG, WEBP, HEIC).', 'INVALID_FILE_TYPE');
  if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'El archivo está vacío.', 'EMPTY_FILE');
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, 'El archivo supera los 10 MB.', 'FILE_TOO_LARGE');
  if (!check(data)) throw new HttpError(415, 'El contenido no coincide con el tipo de archivo.', 'INVALID_FILE_TYPE');
  return type;
}

/**
 * Guarda una factura o un justificante del gasto en `month`. Subir un
 * justificante marca el mes como pagado.
 */
export async function addFile(pool, { expenseId, month, kind, filename, mime, data, userId }) {
  await findActive(pool, expenseId, month);
  const type = validateUpload({ mime, data });
  const entryId = await ensureEntry(pool, expenseId, month);
  const count = await pool.query('SELECT count(*)::int AS n FROM expense_files WHERE entry_id = $1', [entryId]);
  if (count.rows[0].n >= MAX_FILES_PER_ENTRY) {
    throw new HttpError(409, `Como máximo ${MAX_FILES_PER_ENTRY} documentos por gasto y mes.`, 'TOO_MANY_FILES');
  }
  const inserted = await pool.query(
    `INSERT INTO expense_files (entry_id, kind, filename, mime, size_bytes, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [entryId, kind, cleanFilename(filename), type, data.length, data, userId],
  );
  if (kind === 'justificante') {
    await pool.query(
      "UPDATE recurring_entries SET status = 'pagado', paid_at = COALESCE(paid_at, NOW()) WHERE id = $1",
      [entryId],
    );
  }
  return inserted.rows[0].id;
}

export async function getFile(pool, fileId) {
  const result = await pool.query('SELECT filename, mime, data FROM expense_files WHERE id = $1', [fileId]);
  if (result.rowCount === 0) throw new HttpError(404, 'Ese documento no existe.', 'FILE_NOT_FOUND');
  return result.rows[0];
}

/** Borra un documento. Si era el último justificante, el mes vuelve a «pendiente». */
export async function deleteFile(pool, fileId) {
  const removed = await pool.query('DELETE FROM expense_files WHERE id = $1 RETURNING entry_id, kind', [fileId]);
  if (removed.rowCount === 0) throw new HttpError(404, 'Ese documento no existe.', 'FILE_NOT_FOUND');
  const { entry_id: entryId, kind } = removed.rows[0];
  if (kind !== 'justificante') return;
  const left = await pool.query(
    "SELECT 1 FROM expense_files WHERE entry_id = $1 AND kind = 'justificante' LIMIT 1",
    [entryId],
  );
  if (left.rowCount === 0) {
    await pool.query("UPDATE recurring_entries SET status = 'pendiente', paid_at = NULL WHERE id = $1", [entryId]);
  }
}
