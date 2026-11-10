import { HttpError } from '../http-error.js';
import { addFile, deleteFile, readFileKind, validateUpload } from '../services/expense-files.js';
import {
  actualizarGasto, actualizarMensual, crearGasto, crearMensual, escribirDia, gastoActual, gastoDelAntiguo,
  huellaDia, huellaGasto, huellaMensual, mensualDelAntiguo,
} from './registros.js';
import { COLUMNAS, RESPETADO, buscarItem, guardarItem } from './sincronizar.js';

// Lo que se decide a mano en Admin › Sistema antiguo sobre cada registro:
// - cambio:    actualizar (manda el antiguo) · mantener (manda el nuevo) · ignorar
// - revisar:   asignar el archivo a un gasto (factura o justificante) · ignorar
// - importado: quitar (se borra del nuevo y no se vuelve a traer)
// - ignorado / respetado: traer igualmente

const HUELLA = Object.freeze({ dia: huellaDia, gasto: huellaGasto, mensual: huellaMensual, adjunto: () => null });

export async function cargarItem(db, id) {
  const item = (await db.query(`SELECT ${COLUMNAS} FROM legacy_items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!item) throw new HttpError(404, 'Ese registro no existe.', 'NOT_FOUND');
  return item;
}

const exigir = (cond, mensaje) => {
  if (!cond) throw new HttpError(409, mensaje, 'INVALID_ACTION');
};

async function actualizar(db, item, userId) {
  exigir(item.state === 'cambio', 'Solo se actualiza lo que ha cambiado en el antiguo.');
  exigir(item.source === 'dia' || item.expense_id, 'Ese gasto ya no está en el programa nuevo: usa «Traer igualmente» si lo quieres.');
  if (item.source === 'dia') await escribirDia(db, item.data, userId);
  else if (item.source === 'gasto') await actualizarGasto(db, item.expense_id, gastoDelAntiguo(item.data));
  else await actualizarMensual(db, item.expense_id, mensualDelAntiguo(item.data));
  return { state: 'hecho', fingerprint: HUELLA[item.source](item.data), reason: null };
}

async function quitar(db, item) {
  exigir(item.state === 'importado' && item.source !== 'dia', 'Solo se quita un gasto o un archivo traído (los días se corrigen en Caja).');
  if (item.source === 'adjunto') {
    if (item.file_id) await deleteFile(db, item.file_id);
  } else if (item.expense_id) {
    await db.query('DELETE FROM recurring_expenses WHERE id = $1', [item.expense_id]);
  }
  return { state: 'ignorado', expense_id: null, file_id: null, reason: 'Quitado a mano: no se vuelve a traer' };
}

async function traer(db, item, userId) {
  const respetado = item.reason?.startsWith(RESPETADO);
  exigir(item.state === 'ignorado' || respetado, 'Esto ya está en el programa nuevo.');
  const fingerprint = HUELLA[item.source](item.data);
  // Ignorado tras un cambio: su gasto sigue aquí, así que vuelve a contar como traído.
  if (!respetado && item.expense_id && await gastoActual(db, item.expense_id)) {
    return { state: 'importado', fingerprint: null, reason: null };
  }
  if (item.source === 'gasto') return { state: 'importado', expense_id: await crearGasto(db, item.data, userId), fingerprint, reason: null };
  if (item.source === 'mensual') {
    exigir(mensualDelAntiguo(item.data).month, 'Ese gasto mensual no tiene un mes válido.');
    return { state: 'importado', expense_id: await crearMensual(db, item.data, userId), fingerprint, reason: null };
  }
  if (item.source === 'adjunto') return { state: 'revisar', reason: 'Elige a qué gasto va' };
  // Día: se vuelve a mirar en la próxima sincronización.
  return { state: 'cambio', fingerprint: null, reason: 'Vuelve a comparar con la próxima sincronización' };
}

async function asignar(db, item, { gastoId, tipo, fuente, userId }) {
  exigir(item.source === 'adjunto' && item.state === 'revisar', 'Este archivo ya está resuelto.');
  const kind = readFileKind(tipo);
  const id = Number(gastoId);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(400, 'Elige a qué gasto va el archivo.', 'INVALID_EXPENSE');
  const gasto = await gastoActual(db, id);
  if (!gasto || gasto.category === 'proveedor') throw new HttpError(404, 'Ese gasto no existe.', 'EXPENSE_NOT_FOUND');
  const archivo = await fuente().then((f) => f.archivo(item.legacy_id));
  if (!archivo) throw new HttpError(410, 'El archivo ya no está en el servidor antiguo.', 'GONE');
  const mime = validateUpload({ mime: archivo.mime || item.data.content_type, data: archivo.data });
  const month = gasto.kind === 'unico' ? gasto.month : `${String(item.data.sale_date).slice(0, 7)}-01`;
  const fileId = await addFile(db, { expenseId: gasto.id, month, kind, filename: item.data.original_filename, mime, data: archivo.data, userId });
  return { state: 'importado', expense_id: gasto.id, file_id: fileId, reason: kind === 'justificante' ? 'Justificante de pago' : null };
}

/**
 * Aplica `accion` a un registro y devuelve { antes, despues } para el log.
 * `fuente` es una función que conecta con el antiguo (solo para «asignar»).
 */
export async function resolverItem(pool, id, { accion, gastoId, tipo, userId, fuente }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await cargarItem(client, id);
    let cambios;
    if (accion === 'actualizar') cambios = await actualizar(client, item, userId);
    else if (accion === 'mantener') {
      exigir(item.state === 'cambio', 'Solo se mantiene lo que ha cambiado en el antiguo.');
      cambios = { state: 'hecho', fingerprint: HUELLA[item.source](item.data), reason: 'Se mantuvo lo del programa nuevo' };
    } else if (accion === 'ignorar') {
      exigir(['cambio', 'revisar'].includes(item.state), 'Solo se ignora un cambio o un archivo pendiente.');
      cambios = { state: 'ignorado', fingerprint: HUELLA[item.source](item.data), reason: 'Ignorado a mano' };
    } else if (accion === 'quitar') cambios = await quitar(client, item);
    else if (accion === 'traer') cambios = await traer(client, item, userId);
    else if (accion === 'asignar') cambios = await asignar(client, item, { gastoId, tipo, fuente, userId });
    else throw new HttpError(400, 'Acción no válida.', 'INVALID_ACTION');
    await guardarItem(client, item, { ...cambios, resolved_by: userId });
    await client.query('COMMIT');
    return { antes: item, despues: await buscarItem(pool, item.source, item.legacy_id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
