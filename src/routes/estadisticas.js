import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { httpErrorHandler } from '../http-error.js';
import { auditFrom, diffFields } from '../services/audit.js';
import { formatEuros } from '../services/money.js';
import { buildSalesWorkbook, writeZip } from '../services/exports.js';
import { getTargets, readTargets, salesExportData, salesStats, saveTargets, staffStats } from '../services/sales-stats.js';

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const TARGET_LABELS = Object.freeze({ dailyCents: 'Objetivo diario', weeklyCents: 'Objetivo semanal', monthlyCents: 'Objetivo mensual' });
const asEuros = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, formatEuros(v)]));

export function estadisticasRouter({ pool, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);

  // ?periodo=3m|6m|12m|anio&simular=1
  router.get('/', handle(async (req, res) => {
    const data = await salesStats(pool, {
      period: String(req.query.periodo ?? '12m'),
      simulate: req.query.simular === '1',
    });
    res.json({ ok: true, data });
  }));

  // Ventas por empleado: Administrador y Asesor (son datos del equipo).
  router.get('/empleados', requireRole('admin', 'asesor'), handle(async (req, res) => {
    const data = await staffStats(pool, {
      period: String(req.query.periodo ?? '12m'),
      simulate: req.query.simular === '1',
    });
    res.json({ ok: true, data });
  }));

  // ZIP con el Excel de ventas del periodo (cada ticket, por día y por empleado).
  // Lleva quién estaba en cada turno: solo Administrador y Asesor.
  router.get('/exportar', requireRole('admin', 'asesor'), handle(async (req, res) => {
    const data = await salesExportData(pool, {
      period: String(req.query.periodo ?? '12m'),
      simulate: req.query.simular === '1',
    });
    const span = `${data.from}_a_${data.to}${data.simulated ? '_SIMULADO' : ''}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="puntapie_ventas_${span}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await writeZip(res, { workbook: buildSalesWorkbook(data), workbookName: `ventas_${span}.xlsx` });
      await audit(req, {
        area: 'ventas',
        action: 'exportar',
        target: `Del ${data.from.split('-').reverse().join('/')} al ${data.to.split('-').reverse().join('/')}${data.simulated ? ' (simulado)' : ''}`,
        changes: [{ field: 'Contenido', from: null, to: `${data.sales.length} ventas` }],
      });
    } catch (error) {
      log.error('[estadisticas] Exportación interrumpida:', error.message);
      res.destroy(error);
    }
  }));

  router.get('/objetivos', handle(async (_req, res) => {
    res.json({ ok: true, data: await getTargets(pool) });
  }));

  // Cambiar los objetivos es cosa del Administrador.
  router.put('/objetivos', requireRole('admin'), handle(async (req, res) => {
    const before = await getTargets(pool);
    const saved = await saveTargets(pool, readTargets(req.body), req.user.id);
    const changes = diffFields(asEuros(before), asEuros(saved), TARGET_LABELS);
    if (changes.length) await audit(req, { area: 'objetivos', action: 'editar', target: 'Objetivos de venta', changes });
    res.json({ ok: true, data: saved });
  }));

  router.use(httpErrorHandler);
  return router;
}
