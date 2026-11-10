import { addFile, validateUpload } from '../services/expense-files.js';
import { getDay } from '../services/daily-sales.js';
import { SUPPLIER_PAYMENT } from '../services/sales-import.js';
import { todayInShop } from '../services/vacation-balance.js';
import {
  conceptoDe, crearGasto, crearMensual, diaDelAntiguo, diferenciasDia, diferenciasGasto, escribirDia, gastoActual,
  gastoDelAntiguo, huellaDia, huellaGasto, huellaMensual, mensualDelAntiguo, mensualExistente, mesDe,
} from './registros.js';

// Trae de gestiondegastos lo que falte en el programa nuevo:
// - Días de caja que no estén (solo días ya cerrados: hasta ayer).
// - Gastos diarios (menos los pagos a proveedores, que van en Proveedores).
// - Gastos mensuales, salvo que ese mes ya haya un gasto con ese concepto: se respeta.
// - Los archivos de gasto de cada día: se pegan solos si es obvio a qué gasto
//   van (un gasto y un archivo ese día); si no, quedan para revisar.
// Nada que ya esté se pisa: si allí cambia algo ya traído, queda como «cambio»
// para que se elija actualizar o mantener.

export const RESPETADO = 'Ya estaba en el programa nuevo';
const SIN_IMPORTE = 'Sin importe en el antiguo';
const BORRADO = 'Se borró en el programa nuevo';
// Columnas de legacy_items (la fecha como texto: pg convertiría DATE a hora local).
export const COLUMNAS = `id, source, legacy_id, state, to_char(day, 'YYYY-MM-DD') AS day, fingerprint, data, expense_id, file_id,
  reason, run_id, created_at, updated_at, resolved_by`;

async function enTransaccion(pool, trabajo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const valor = await trabajo(client);
    await client.query('COMMIT');
    return valor;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function buscarItem(db, source, legacyId, { bloquear = false } = {}) {
  return (await db.query(
    `SELECT ${COLUMNAS} FROM legacy_items WHERE source = $1 AND legacy_id = $2${bloquear ? ' FOR UPDATE' : ''}`,
    [source, legacyId],
  )).rows[0] ?? null;
}

/** Crea o actualiza la fila del registro (lo que no se pasa, se conserva). */
export async function guardarItem(db, previo, cambios) {
  const v = { expense_id: null, file_id: null, reason: null, fingerprint: null, day: null, ...previo, ...cambios };
  await db.query(
    `INSERT INTO legacy_items (source, legacy_id, state, day, fingerprint, data, expense_id, file_id, reason, run_id, resolved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source, legacy_id) DO UPDATE SET state = EXCLUDED.state, day = EXCLUDED.day, fingerprint = EXCLUDED.fingerprint,
       data = EXCLUDED.data, expense_id = EXCLUDED.expense_id, file_id = EXCLUDED.file_id, reason = EXCLUDED.reason,
       run_id = COALESCE(EXCLUDED.run_id, legacy_items.run_id), resolved_by = EXCLUDED.resolved_by, updated_at = NOW()`,
    [v.source, v.legacy_id, v.state, v.day, v.fingerprint, JSON.stringify(v.data), v.expense_id, v.file_id, v.reason, v.run_id ?? null, v.resolved_by ?? null],
  );
}

const textoDifs = (difs) => difs.map((d) => `${d.campo}: ${d.antiguo} (antiguo) / ${d.nuevo} (nuevo)`).join('\n');

/* ---------- Días ---------- */

async function sincronizarDia(db, r, ctx, res) {
  const item = await buscarItem(db, 'dia', r.id, { bloquear: true });
  if (item?.state === 'ignorado') return;
  const fp = huellaDia(r);
  if (item && item.fingerprint === fp && item.state !== 'cambio') return;
  const base = { source: 'dia', legacy_id: r.id, day: r.sale_date, data: r, run_id: ctx.runId };
  const antiguo = diaDelAntiguo(r);
  const actual = await getDay(db, antiguo.day);
  if (!actual.exists) {
    await escribirDia(db, r, ctx.userId);
    await guardarItem(db, item, { ...base, state: 'importado', fingerprint: fp, reason: null });
    res.dias += 1;
    return;
  }
  const difs = diferenciasDia(antiguo, actual);
  if (!difs.length) {
    await guardarItem(db, item, { ...base, state: item?.state === 'cambio' ? 'hecho' : item?.state ?? 'hecho', fingerprint: fp, reason: null });
    return;
  }
  if (item?.state !== 'cambio') res.cambios += 1;
  await guardarItem(db, item, { ...base, state: 'cambio', reason: textoDifs(difs) });
}

/* ---------- Gastos diarios ---------- */

async function sincronizarGasto(db, g, ctx, res) {
  const item = await buscarItem(db, 'gasto', g.id, { bloquear: true });
  if (item?.state === 'ignorado') return;
  const fp = huellaGasto(g);
  const base = { source: 'gasto', legacy_id: g.id, day: g.sale_date, data: g, run_id: ctx.runId };
  if (SUPPLIER_PAYMENT.test(conceptoDe(g))) {
    if (!item) await guardarItem(db, null, { ...base, state: 'ignorado', fingerprint: fp, reason: 'Pago a proveedor: ya cuenta en Proveedores' });
    return;
  }
  // Su gasto se borró aquí: no vuelve, aunque en el antiguo no haya cambiado.
  if (item && !item.expense_id) {
    await guardarItem(db, item, { ...base, state: 'ignorado', fingerprint: fp, reason: BORRADO });
    return;
  }
  if (item && item.fingerprint === fp && item.state !== 'cambio') return;
  // Puede venir ya del ZIP de la app antigua (legacy_ref), sin fila aquí todavía.
  const expenseId = item ? item.expense_id
    : (await db.query('SELECT id FROM recurring_expenses WHERE legacy_ref = $1', [`gestiondegastos:${g.id}`])).rows[0]?.id ?? null;
  if (!expenseId) {
    const id = await crearGasto(db, g, ctx.userId);
    await guardarItem(db, null, { ...base, state: 'importado', fingerprint: fp, expense_id: id });
    res.gastos += 1;
    return;
  }
  const actual = await gastoActual(db, expenseId);
  const difs = diferenciasGasto(gastoDelAntiguo(g), actual);
  if (!difs.length) {
    await guardarItem(db, item, { ...base, state: item?.state === 'cambio' ? 'hecho' : item?.state ?? 'importado', fingerprint: fp, expense_id: expenseId, reason: null });
    return;
  }
  if (item?.state !== 'cambio') res.cambios += 1;
  await guardarItem(db, item, { ...base, state: 'cambio', expense_id: expenseId, reason: textoDifs(difs) });
}

/* ---------- Gastos mensuales ---------- */

async function sincronizarMensual(db, m, ctx, res) {
  const item = await buscarItem(db, 'mensual', m.id, { bloquear: true });
  if (item?.state === 'ignorado') return;
  const fp = huellaMensual(m);
  // Sin gasto aquí solo puede estar lo que no tenía importe o se respetó; si no, se borró.
  const borrado = Boolean(item) && !item.expense_id && item.reason !== SIN_IMPORTE && !item.reason?.startsWith(RESPETADO);
  if (item && item.fingerprint === fp && item.state !== 'cambio' && !borrado) return;
  const x = mensualDelAntiguo(m);
  const base = { source: 'mensual', legacy_id: m.id, day: x.month, data: m, run_id: ctx.runId };
  if (SUPPLIER_PAYMENT.test(x.name)) {
    if (!item) await guardarItem(db, null, { ...base, state: 'ignorado', fingerprint: fp, reason: 'Pago a proveedor: ya cuenta en Proveedores' });
    return;
  }
  // Respetado: lo de ese mes en el nuevo manda; solo se anota cómo está allí.
  if (item?.reason?.startsWith(RESPETADO)) {
    await guardarItem(db, item, { ...base, fingerprint: fp });
    return;
  }
  if (borrado) {
    await guardarItem(db, item, { ...base, state: 'ignorado', fingerprint: fp, reason: BORRADO });
    return;
  }
  if (!item?.expense_id) {
    if (!x.amountCents) {
      await guardarItem(db, item, { ...base, state: 'hecho', fingerprint: fp, reason: SIN_IMPORTE });
      return;
    }
    const existente = await mensualExistente(db, m);
    if (existente) {
      await guardarItem(db, item, { ...base, state: 'hecho', fingerprint: fp, expense_id: existente.id, reason: `${RESPETADO}: «${existente.name}»` });
      res.respetados += 1;
      return;
    }
    const id = await crearMensual(db, m, ctx.userId);
    await guardarItem(db, item, { ...base, state: 'importado', fingerprint: fp, expense_id: id, reason: null });
    res.mensuales += 1;
    return;
  }
  const actual = await gastoActual(db, item.expense_id);
  const difs = diferenciasGasto({ name: x.name, amountCents: x.amountCents }, actual, { conFecha: false });
  if (!difs.length) {
    await guardarItem(db, item, { ...base, state: item.state === 'cambio' ? 'hecho' : item.state, fingerprint: fp, reason: null });
    return;
  }
  if (item.state !== 'cambio') res.cambios += 1;
  await guardarItem(db, item, { ...base, state: 'cambio', reason: textoDifs(difs) });
}

/* ---------- Archivos de gasto ---------- */

/** Por qué no se puede pegar solo (o null si es obvio a qué gasto va). */
function motivoRevisar(gastosDia, archivosDia) {
  if (!gastosDia.length) return 'Ese día no hay ningún gasto apuntado: elige a cuál va o ignóralo';
  if (gastosDia.length === 1 && SUPPLIER_PAYMENT.test(conceptoDe(gastosDia[0]))) {
    return `Ese día solo hay un pago a proveedor («${conceptoDe(gastosDia[0])}»): si es su factura o justificante, súbelo en Proveedores`;
  }
  if (gastosDia.length > 1 || archivosDia.length > 1) {
    return `Ese día hay ${gastosDia.length} gasto${gastosDia.length === 1 ? '' : 's'} y ${archivosDia.length} archivos: elige a cuál va cada uno`;
  }
  return null;
}

async function sincronizarAdjunto(db, a, ctx, res) {
  const item = await buscarItem(db, 'adjunto', a.id, { bloquear: true });
  if (item) return; // cada archivo se mira una sola vez; lo pendiente se resuelve a mano
  const base = { source: 'adjunto', legacy_id: a.id, day: a.sale_date, data: a, run_id: ctx.runId };
  const gastosDia = ctx.gastos.filter((g) => g.sale_date === a.sale_date);
  const archivosDia = ctx.archivos.filter((x) => x.sale_date === a.sale_date);
  const revisar = async (reason) => {
    await guardarItem(db, null, { ...base, state: 'revisar', reason });
    res.revisar += 1;
  };
  const motivo = motivoRevisar(gastosDia, archivosDia);
  if (motivo) return revisar(motivo);
  const gasto = await buscarItem(db, 'gasto', gastosDia[0].id);
  if (!gasto) return; // el gasto no se pudo traer en esta pasada: se reintenta en la próxima
  if (!gasto.expense_id) return revisar('El gasto de ese día no está en el programa nuevo: elige a cuál va o ignóralo');
  const archivo = await ctx.fuente.archivo(a.id);
  if (!archivo) return revisar('El archivo ya no está en el servidor antiguo');
  let mime;
  try {
    mime = validateUpload({ mime: archivo.mime || a.content_type, data: archivo.data });
  } catch (error) {
    return revisar(`No se puede guardar: ${error.message}`);
  }
  const { month } = await gastoActual(db, gasto.expense_id);
  const fileId = await addFile(db, {
    expenseId: gasto.expense_id, month, kind: 'factura', filename: a.original_filename, mime, data: archivo.data, userId: ctx.userId,
  });
  await guardarItem(db, null, { ...base, state: 'importado', expense_id: gasto.expense_id, file_id: fileId });
  res.adjuntos += 1;
}

/* ---------- Todo junto ---------- */

const desde = (inicio, hasta) => (r) => r.sale_date >= inicio && r.sale_date < hasta;

/**
 * Una sincronización completa con la `fuente` (ver cliente.js). Cada registro
 * va en su propia transacción: si uno falla, el resto sigue y se cuenta el error.
 */
export async function sincronizar(pool, fuente, { inicio, userId = null, runId = null, hoy = todayInShop(), log = console }) {
  const [ventas, gastos, mensuales, archivos] = await Promise.all([
    fuente.ventas(), fuente.gastosDiarios(), fuente.gastosMensuales(), fuente.adjuntos(),
  ]);
  const enPeriodo = desde(inicio, hoy);
  const mesActual = `${hoy.slice(0, 7)}-01`;
  const ctx = {
    fuente, userId, runId,
    gastos: gastos.filter(enPeriodo),
    archivos: archivos.filter((a) => a.kind === 'gasto' && enPeriodo(a)),
  };
  const res = { dias: 0, gastos: 0, mensuales: 0, adjuntos: 0, respetados: 0, cambios: 0, revisar: 0, errores: [] };
  const pasos = [
    ...ventas.filter(enPeriodo).map((r) => [sincronizarDia, r, `caja del ${r.sale_date}`]),
    ...ctx.gastos.map((g) => [sincronizarGasto, g, `gasto «${conceptoDe(g)}» del ${g.sale_date}`]),
    ...mensuales.filter((m) => mesDe(m) && mesDe(m) >= `${inicio.slice(0, 7)}-01` && mesDe(m) <= mesActual)
      .map((m) => [sincronizarMensual, m, `mensual «${m.name || m.category}» de ${String(m.month_key).slice(0, 7)}`]),
    ...ctx.archivos.map((a) => [sincronizarAdjunto, a, `archivo «${a.original_filename}» del ${a.sale_date}`]),
  ];
  for (const [paso, registro, que] of pasos) {
    try {
      await enTransaccion(pool, (db) => paso(db, registro, ctx, res));
    } catch (error) {
      log.error(`[antiguo] No se pudo sincronizar ${que}:`, error.message);
      res.errores.push(`${que}: ${error.message}`);
    }
  }
  return res;
}
