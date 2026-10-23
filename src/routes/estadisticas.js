import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { httpErrorHandler } from '../http-error.js';
import { getTargets, readTargets, salesStats, saveTargets } from '../services/sales-stats.js';

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function estadisticasRouter({ pool }) {
  const router = Router();

  // ?periodo=3m|6m|12m|anio&simular=1
  router.get('/', handle(async (req, res) => {
    const data = await salesStats(pool, {
      period: String(req.query.periodo ?? '12m'),
      simulate: req.query.simular === '1',
    });
    res.json({ ok: true, data });
  }));

  router.get('/objetivos', handle(async (_req, res) => {
    res.json({ ok: true, data: await getTargets(pool) });
  }));

  // Cambiar los objetivos es cosa del Administrador.
  router.put('/objetivos', requireRole('admin'), handle(async (req, res) => {
    res.json({ ok: true, data: await saveTargets(pool, readTargets(req.body), req.user.id) });
  }));

  router.use(httpErrorHandler);
  return router;
}
