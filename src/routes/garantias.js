import express, { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { sendStoredFile } from '../http-files.js';
import { auditFrom } from '../services/audit.js';
import { MAX_FILE_BYTES } from '../services/expense-files.js';
import { formatEuros } from '../services/money.js';
import {
  anadirArchivo, borrarArchivo, editarIncidencia, leerArchivo, listarIncidencias, obtenerIncidencia, RESOLUCIONES, reclamarIncidencia, resolverIncidencia,
} from '../tpv/garantias.js';

// Garantías: incidencias de los productos devueltos como defectuosos (en
// cuarentena). Las ven y completan quienes venden; las cierra un Administrador.

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function readId(value, label = 'Esa incidencia') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

export function garantiasRouter({ pool, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const vende = requireRole('admin', 'empleado');
  const nombre = (c) => `Incidencia ${c.id} · ${c.descripcion}`;

  router.get('/', handle(async (req, res) => {
    res.json({ ok: true, data: await listarIncidencias(pool, { estado: String(req.query.estado ?? 'pendientes') }) });
  }));

  router.get('/archivos/:fileId', handle(async (req, res) => {
    sendStoredFile(res, await leerArchivo(pool, readId(req.params.fileId, 'Ese archivo')), { download: req.query.descargar === '1' });
  }));

  router.delete('/archivos/:fileId', vende, handle(async (req, res) => {
    const f = await borrarArchivo(pool, readId(req.params.fileId, 'Ese archivo'));
    await audit(req, { area: 'garantias', action: 'quitar', target: `Incidencia ${f.incidencia}`, changes: [{ field: 'Archivo', from: f.nombre, to: null }] });
    res.json({ ok: true });
  }));

  router.get('/:id', handle(async (req, res) => {
    res.json({ ok: true, data: await obtenerIncidencia(pool, readId(req.params.id)) });
  }));

  router.patch('/:id', vende, handle(async (req, res) => {
    const id = readId(req.params.id);
    const { antes, despues } = await editarIncidencia(pool, id, { defecto: req.body?.defecto, proveedor_id: req.body?.proveedor_id });
    const c = await obtenerIncidencia(pool, id);
    const changes = [];
    if (antes.defecto !== despues.defecto) changes.push({ field: 'Defecto', from: antes.defecto, to: despues.defecto });
    if (antes.proveedor_id !== despues.proveedor_id) changes.push({ field: 'Proveedor', from: antes.proveedor_id, to: c.proveedor });
    if (changes.length) await audit(req, { area: 'garantias', action: 'editar', target: nombre(c), changes });
    res.json({ ok: true, data: c });
  }));

  router.post('/:id/reclamar', vende, handle(async (req, res) => {
    const id = readId(req.params.id);
    await reclamarIncidencia(pool, id, req.body ?? {}, req.user);
    const c = await obtenerIncidencia(pool, id);
    await audit(req, {
      area: 'garantias', action: 'editar', target: nombre(c),
      changes: [{ field: 'Reclamada a', from: null, to: [c.proveedor, c.reclamacion?.referencia].filter(Boolean).join(' · ') }],
    });
    res.json({ ok: true, data: c });
  }));

  router.post('/:id/resolver', requireRole('admin'), handle(async (req, res) => {
    const id = readId(req.params.id);
    const r = await resolverIncidencia(pool, id, req.body ?? {}, req.user);
    const c = await obtenerIncidencia(pool, id);
    await audit(req, {
      area: 'garantias', action: 'editar', target: nombre(c),
      changes: [
        { field: 'Resolución', from: null, to: RESOLUCIONES[c.resolucion.tipo] },
        ...(c.resolucion.importe_cent ? [{ field: 'Importe', from: null, to: formatEuros(c.resolucion.importe_cent) }] : []),
        ...(r.al_stock ? [{ field: 'Vuelven al stock', from: null, to: `${r.al_stock} ud.` }] : []),
      ],
    });
    res.json({ ok: true, data: c });
  }));

  // Foto o documento: el cuerpo es el archivo tal cual; el nombre va en X-File-Name.
  router.post(
    '/:id/archivos',
    vende,
    express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
    handle(async (req, res) => {
      const id = readId(req.params.id);
      const f = await anadirArchivo(pool, id, { filename: req.get('X-File-Name'), mime: req.get('Content-Type'), data: req.body, usuario: req.user });
      await audit(req, { area: 'garantias', action: 'subir', target: `Incidencia ${id}`, changes: [{ field: 'Archivo', from: null, to: f.nombre }] });
      res.status(201).json({ ok: true, data: await obtenerIncidencia(pool, id) });
    }),
  );

  router.use(httpErrorHandler);
  return router;
}
