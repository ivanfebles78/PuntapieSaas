import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { abrirBuzonCon, correoConfigurado, revisarConCandado } from '../correo/programador.js';
import { analizarPdf } from '../proveedores/analisis.js';

// Correo: estado de la revisión diaria, «Revisar ahora» y lo que quedó para revisar.

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, 'Ese documento no existe.', 'NOT_FOUND');
  return id;
}

const PENDIENTE = `
  SELECT a.id, a.filename, a.kind, a.state, a.reason, a.doc_id, a.expense_id, to_char(a.month, 'YYYY-MM') AS mes,
         a.created_at, a.data IS NOT NULL AS tiene_pdf, m.from_addr, m.subject, m.sent_at
    FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_ref`;

const publico = (r) => ({
  id: r.id, archivo: r.filename, tipo: r.kind, estado: r.state, motivo: r.reason, documento_id: r.doc_id, gasto_id: r.expense_id,
  mes: r.mes, pdf: r.tiene_pdf, de: r.from_addr, asunto: r.subject, fecha: r.sent_at,
});

async function pendiente(pool, id) {
  const r = (await pool.query(`${PENDIENTE} WHERE a.id = $1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Ese documento no existe.', 'NOT_FOUND');
  return r;
}

export function correoRouter({ pool, config, log = console }) {
  const router = Router();
  const canWrite = requireRole('admin', 'empleado');

  router.get('/estado', handle(async (_req, res) => {
    const ultima = (await pool.query(
      'SELECT origin, started_at, finished_at, summary, error FROM mail_runs ORDER BY started_at DESC LIMIT 1',
    )).rows[0] ?? null;
    const n = (await pool.query("SELECT count(*)::int AS n FROM mail_attachments WHERE state IN ('revisar', 'productos')")).rows[0].n;
    res.json({
      ok: true,
      data: {
        configurado: correoConfigurado(config),
        cuenta: config.correo.user || null,
        hora: config.correo.hora,
        pendientes: n,
        ultima: ultima && { origen: ultima.origin, inicio: ultima.started_at, fin: ultima.finished_at, resumen: ultima.summary, error: ultima.error },
      },
    });
  }));

  router.post('/revisar', canWrite, handle(async (req, res) => {
    if (!correoConfigurado(config)) throw new HttpError(409, 'Falta conectar el correo: añade GMAIL_USER y GMAIL_APP_PASSWORD en Railway.', 'MAIL_OFF');
    let r;
    try {
      r = await revisarConCandado(pool, {
        abrirBuzon: abrirBuzonCon(config, log), origen: 'manual', userId: req.user.id, inicio: config.businessStart.slice(0, 7), log,
      });
    } catch (error) {
      throw new HttpError(502, `No se pudo revisar el correo: ${error.message}`, 'MAIL_ERROR');
    }
    if (!r) throw new HttpError(409, 'Ya se está revisando el correo; espera un momento.', 'MAIL_BUSY');
    res.json({ ok: true, data: r });
  }));

  router.get('/pendientes', handle(async (_req, res) => {
    const rows = (await pool.query(`${PENDIENTE} WHERE a.state IN ('revisar', 'productos') ORDER BY m.sent_at DESC NULLS LAST, a.id`)).rows;
    res.json({ ok: true, data: rows.map(publico) });
  }));

  router.get('/pendientes/:id/archivo', handle(async (req, res) => {
    const r = (await pool.query('SELECT filename, data FROM mail_attachments WHERE id = $1 AND data IS NOT NULL', [readId(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, 'Ese PDF ya no está guardado.', 'NOT_FOUND');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
    res.send(r.data);
  }));

  // Lo abre en «Importar PDF» como si se hubiera subido: se revisa y se guarda allí.
  router.post('/pendientes/:id/analizar', canWrite, handle(async (req, res) => {
    const p = await pendiente(pool, readId(req.params.id));
    if (p.state !== 'revisar' || !p.tiene_pdf) throw new HttpError(409, 'Este documento ya está resuelto.', 'RESOLVED');
    const { data } = (await pool.query('SELECT data FROM mail_attachments WHERE id = $1', [p.id])).rows[0];
    const analisis = await analizarPdf(pool, { data, filename: p.filename, mime: 'application/pdf' }, { userId: req.user.id, settings: config.proveedores });
    res.json({ ok: true, data: { ...analisis, correo_id: p.id } });
  }));

  for (const [accion, estado] of [['hecho', 'hecho'], ['descartar', 'descartado']]) {
    router.post(`/pendientes/:id/${accion}`, canWrite, handle(async (req, res) => {
      const id = readId(req.params.id);
      const r = await pool.query(
        `UPDATE mail_attachments SET state = $2, resolved_at = NOW(), data = NULL
          WHERE id = $1 AND state IN ('revisar', 'productos') RETURNING id`,
        [id, estado],
      );
      if (!r.rowCount) throw new HttpError(409, 'Este documento ya está resuelto.', 'RESOLVED');
      res.json({ ok: true });
    }));
  }

  router.use(httpErrorHandler);
  return router;
}
