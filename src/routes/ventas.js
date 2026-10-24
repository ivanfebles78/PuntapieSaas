import express, { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { auditFrom } from '../services/audit.js';
import { diffDay, getDay, listDays, saveDay } from '../services/daily-sales.js';
import { formatEuros, readDay } from '../services/money.js';
import { importSales } from '../services/sales-import.js';

// Ventas › Caja diaria: ventas del día por turno y método, a mano o importadas.

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
const MAX_RANGE_DAYS = 400;
const DAY_MS = 86400000;
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const esDate = (iso) => iso.split('-').reverse().join('/');

export function ventasRouter({ pool, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);

  router.get('/dia/:fecha', handle(async (req, res) => {
    res.json({ ok: true, data: await getDay(pool, readDay(req.params.fecha)) });
  }));

  // Apuntar la caja: Administrador y Empleado (el Asesor ya está bloqueado antes).
  router.put('/dia/:fecha', requireRole('admin', 'empleado'), handle(async (req, res) => {
    const { before, after } = await saveDay(pool, req.params.fecha, req.body ?? {}, req.user.id);
    const changes = diffDay(before, after);
    if (changes.length) {
      await audit(req, { area: 'ventas', action: before.exists ? 'editar' : 'crear', target: `Caja del ${esDate(after.day)}`, changes });
    }
    res.json({ ok: true, data: after });
  }));

  // ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
  router.get('/dias', handle(async (req, res) => {
    const to = readDay(req.query.hasta, 'La fecha final');
    const from = readDay(req.query.desde, 'La fecha inicial');
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (days < 0 || days > MAX_RANGE_DAYS) throw new HttpError(400, `Como máximo ${MAX_RANGE_DAYS} días.`, 'INVALID_RANGE');
    res.json({ ok: true, data: await listDays(pool, from, to) });
  }));

  // Importar la exportación de la app antigua (ZIP o ventas_puntapie.json). Solo el Administrador.
  router.post('/importar', requireRole('admin'), express.raw({ type: () => true, limit: MAX_IMPORT_BYTES }), handle(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Falta el archivo.', 'NO_FILE');
    const result = await importSales(pool, req.body, { userId: req.user.id, fixTypos: req.query.corregir !== '0' });
    await audit(req, {
      area: 'ventas',
      action: 'importar',
      target: 'Ventas de la app antigua',
      changes: [
        { field: 'Días', from: null, to: `${result.dias} días importados (${formatEuros(result.totalCents)}, ${result.clientes} clientes); ${result.yaEstaban} ya estaban` },
        ...(result.gastos ? [{ field: 'Gastos diarios', from: null, to: `${result.gastos} gastos esporádicos (${formatEuros(result.gastosCents)})` }] : []),
        ...result.erratas.map((e) => ({ field: 'Errata corregida', from: null, to: e })),
      ],
    });
    res.json({ ok: true, data: result });
  }));

  router.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande.', code: 'FILE_TOO_LARGE' });
    return next(error);
  });
  router.use(httpErrorHandler);
  return router;
}
