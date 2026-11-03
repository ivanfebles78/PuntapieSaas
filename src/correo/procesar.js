// Revisión del buzón: cada PDF de un correo no leído se registra solo
// (factura/pedido de proveedor o factura de un gasto recurrente) o queda
// «para revisar». El correo se marca como leído solo si todo lo suyo se
// registró; lo que queda para revisar lo deja sin leer hasta que se resuelve.
import crypto from 'node:crypto';
import { extractPdfText } from '../proveedores/extract/pdfText.js';
import { limpiarPdf } from '../proveedores/importar-zip.js';
import { recordAudit } from '../services/audit.js';
import { cleanFilename } from '../services/expense-files.js';
import { registrarGasto } from './gasto.js';
import { reconocerGasto } from './gastos.js';
import { registrarProveedor } from './proveedor.js';

const DIAS_ATRAS = 30;
const ACTOR = Object.freeze({ id: null, name: 'Correo' });
const RESUELTO = new Set(['creado', 'productos', 'ignorado', 'hecho', 'descartado']);
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Qué hacer con un PDF. Nunca lanza: un fallo deja el PDF para revisar. */
async function procesarPdf(pool, adjunto, { mesCorreo, inicio, log }) {
  const { data } = limpiarPdf(adjunto.data);
  const filename = cleanFilename(adjunto.filename);
  // El mismo hash que daría «Importar PDF» con este archivo: así se reconocen los repetidos.
  const sha256 = hash(data);
  const base = { filename, sha256, data };
  try {
    const pdfText = await extractPdfText(data);
    if (pdfText.text.trim().length < 20) return { ...base, kind: 'desconocido', state: 'revisar', reason: 'El PDF no tiene texto (¿escaneado?)' };
    const gasto = reconocerGasto(pdfText.text);
    if (gasto?.clase === 'justificante') return { ...base, kind: 'gasto', state: 'revisar', reason: 'Justificante de pago: asócialo a su factura a mano' };
    if (gasto?.clase === 'original') return { ...base, kind: 'gasto', state: 'ignorado', reason: 'Factura original de la compañía (cuenta la refactura)', original: true };
    if (gasto) return { ...base, kind: 'gasto', ...(await registrarGasto(pool, { gasto: gasto.gasto, pdfText, data, filename, mesCorreo, inicio })) };
    const r = await registrarProveedor(pool, { pdfText, data, filename, sha256 });
    return { ...base, kind: r.desconocido ? 'desconocido' : 'proveedor', ...r };
  } catch (error) {
    log.error('[correo] No se pudo procesar', filename, error.message);
    return { ...base, kind: 'desconocido', state: 'revisar', reason: `No se pudo registrar: ${error.message}` };
  }
}

async function guardarAdjunto(pool, messageRef, r) {
  // El PDF solo se guarda si hay que revisarlo (lo demás ya está en su factura o gasto).
  await pool.query(
    `INSERT INTO mail_attachments (message_ref, filename, sha256, kind, state, reason, doc_id, expense_id, month, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [messageRef, r.filename, r.sha256, r.kind, r.state, r.reason ?? '', r.doc_id ?? null, r.expense_id ?? null, r.month ?? null,
      r.state === 'revisar' ? r.data : null],
  );
}

/** Un correo: procesa sus PDF y dice si se puede marcar como leído. */
async function procesarMensaje(pool, m, { runId, inicio, log }) {
  const fecha = m.date ? new Date(m.date) : new Date();
  const mesCorreo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit' }).format(fecha);
  const ref = (await pool.query(
    `INSERT INTO mail_messages (message_id, uid, from_addr, subject, sent_at, run_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [m.messageId, m.uid, String(m.from ?? '').slice(0, 200), String(m.subject ?? '').slice(0, 300), fecha, runId],
  )).rows[0];
  if (!ref) return null;
  const resultados = [];
  for (const a of m.adjuntos) resultados.push(await procesarPdf(pool, a, { mesCorreo, inicio, log }));
  const registrado = resultados.some((r) => r.state === 'creado' || r.state === 'productos');
  // Una factura original de agua o luz que llega sola (sin la refactura) sí hay que mirarla.
  const finales = resultados.map((r) => (r.original && !registrado ? { ...r, state: 'revisar', reason: 'Factura de agua o luz sin la refactura de la casera' } : r));
  for (const r of finales) await guardarAdjunto(pool, ref.id, r);
  const yaEstaba = finales.length > 0 && finales.every((r) => r.state === 'ignorado' && r.doc_id);
  const leer = finales.length > 0 && finales.every((r) => RESUELTO.has(r.state)) && (registrado || yaEstaba);
  return { id: ref.id, uid: m.uid, leer, resultados: finales };
}

function resumir(mensajes) {
  const todos = mensajes.flatMap((m) => m.resultados);
  const cuenta = (fn) => todos.filter(fn).length;
  return {
    correos: mensajes.length,
    conPdf: mensajes.filter((m) => m.resultados.length).length,
    proveedores: cuenta((r) => r.kind === 'proveedor' && (r.state === 'creado' || r.state === 'productos')),
    gastos: cuenta((r) => r.kind === 'gasto' && r.state === 'creado'),
    revisar: cuenta((r) => r.state === 'revisar') + cuenta((r) => r.state === 'productos'),
    ignorados: cuenta((r) => r.state === 'ignorado'),
    marcadosLeidos: mensajes.filter((m) => m.leer).length,
    detalle: todos.map((r) => ({ archivo: r.filename, estado: r.state, motivo: r.reason ?? '', registro: r.etiqueta ?? null })).slice(0, 100),
  };
}

/** Correos sin leer cuyos PDF ya se resolvieron a mano: ahora sí se marcan como leídos. */
async function resueltosPendientes(pool) {
  return (await pool.query(`
    SELECT m.id, m.uid FROM mail_messages m
     WHERE NOT m.marked_read AND m.uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND (a.state IN ('creado', 'productos', 'hecho') OR a.doc_id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND a.state = 'revisar')`)).rows
    .map((r) => ({ id: r.id, uid: Number(r.uid) }));
}

/**
 * Una revisión completa. `abrirBuzon(trabajo)` da acceso al buzón (inyectable
 * en los tests). Devuelve el resumen guardado en mail_runs.
 */
export async function revisarCorreo(pool, { abrirBuzon, origen = 'auto', userId = null, inicio = '2026-04', log = console, ahora = new Date() }) {
  const run = (await pool.query('INSERT INTO mail_runs (origin, started_by) VALUES ($1, $2) RETURNING id', [origen, userId])).rows[0];
  try {
    const resumen = await abrirBuzon(async (buzon) => {
      const vistos = new Set((await pool.query('SELECT message_id FROM mail_messages')).rows.map((r) => r.message_id));
      const desde = new Date(ahora.getTime() - DIAS_ATRAS * 24 * 60 * 60 * 1000);
      const mensajes = [];
      for (const m of await buzon.noLeidos({ desde, vistos })) {
        const r = await procesarMensaje(pool, m, { runId: run.id, inicio, log });
        if (r) mensajes.push(r);
      }
      const aLeer = new Map([...mensajes.filter((m) => m.leer), ...(await resueltosPendientes(pool))].map((m) => [m.id, m]));
      for (const m of aLeer.values()) {
        await buzon.marcarLeido(m.uid);
        await pool.query('UPDATE mail_messages SET marked_read = TRUE WHERE id = $1', [m.id]);
      }
      return resumir(mensajes);
    });
    await pool.query('UPDATE mail_runs SET finished_at = NOW(), summary = $2 WHERE id = $1', [run.id, resumen]);
    await recordAudit(pool, {
      actor: ACTOR, area: 'correo', action: 'importar', target: `Revisión del correo (${origen === 'auto' ? 'diaria' : 'a mano'})`,
      changes: [
        { field: 'Facturas y pedidos registrados', from: null, to: String(resumen.proveedores) },
        { field: 'Gastos registrados', from: null, to: String(resumen.gastos) },
        { field: 'Para revisar', from: null, to: String(resumen.revisar) },
      ],
    }).catch((error) => log.error('[correo] No se pudo guardar el log:', error.message));
    return { id: run.id, ...resumen };
  } catch (error) {
    await pool.query('UPDATE mail_runs SET finished_at = NOW(), error = $2 WHERE id = $1', [run.id, String(error.message).slice(0, 500)]);
    throw error;
  }
}
