import express, { Router } from 'express';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { MAX_FILE_BYTES, addFile, deleteFile, getFile, readFileKind } from '../services/expense-files.js';
import { readCents, readDay, readMonth } from '../services/money.js';
import {
  createExpense,
  endExpense,
  listExpenses,
  readCategory,
  readKind,
  readName,
  readStatus,
  renameExpense,
  setAmount,
  setStatus,
} from '../services/expenses.js';

function readId(value, label = 'Ese gasto') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

// Cabecera Content-Disposition con nombre UTF-8 (RFC 5987) y alternativa ASCII.
function contentDisposition(filename, mime) {
  const disposition = mime === 'application/pdf' || mime.startsWith('image/') ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Wrapper para no repetir try/catch en cada ruta asíncrona. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function readOptionalCents(value) {
  return value === undefined || value === null || value === '' ? 0 : readCents(value);
}

/** Datos de alta según el tipo: recurrente (fijo/variable desde un mes) o pago único con fecha. */
function readNewExpense(body) {
  const category = readCategory(body?.category ?? 'recurrente');
  const base = { name: readName(body?.name), category };
  if (category === 'recurrente') {
    return {
      ...base,
      kind: readKind(body?.kind),
      amountCents: readOptionalCents(body?.amount),
      startMonth: readMonth(body?.startMonth, 'El mes de inicio'),
    };
  }
  const amountCents = readCents(body?.amount);
  return { ...base, kind: 'unico', amountCents, date: readDay(body?.date) };
}

export function gastosRouter({ pool }) {
  const router = Router();

  /* ---------- Documentos ---------- */

  router.get('/archivos/:fileId', handle(async (req, res) => {
    const file = await getFile(pool, readId(req.params.fileId, 'Ese documento'));
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', contentDisposition(file.filename, file.mime));
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    // Los documentos se abren en su propia pestaña, sin poder ejecutar nada.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(file.data);
  }));

  router.delete('/archivos/:fileId', handle(async (req, res) => {
    await deleteFile(pool, readId(req.params.fileId, 'Ese documento'));
    res.json({ ok: true });
  }));

  /* ---------- Gastos ---------- */

  // ?mes=AAAA-MM, o ?desde=AAAA-MM&hasta=AAAA-MM para varios meses.
  router.get('/', handle(async (req, res) => {
    const from = readMonth(req.query.desde ?? req.query.mes);
    const to = req.query.hasta ? readMonth(req.query.hasta, 'El mes final') : from;
    res.json({ ok: true, data: await listExpenses(pool, from, to) });
  }));

  router.post('/', handle(async (req, res) => {
    const id = await createExpense(pool, { ...readNewExpense(req.body), userId: req.user.id });
    res.status(201).json({ ok: true, data: { id } });
  }));

  router.patch('/:id', handle(async (req, res) => {
    await renameExpense(pool, readId(req.params.id), readName(req.body?.name));
    res.json({ ok: true });
  }));

  router.put('/:id/importe', handle(async (req, res) => {
    await setAmount(pool, {
      expenseId: readId(req.params.id),
      month: readMonth(req.body?.month),
      amountCents: readCents(req.body?.amount),
      scope: req.body?.scope === 'desde' ? 'desde' : 'mes',
    });
    res.json({ ok: true });
  }));

  router.put('/:id/estado', handle(async (req, res) => {
    await setStatus(pool, {
      expenseId: readId(req.params.id),
      month: readMonth(req.body?.month),
      status: readStatus(req.body?.status),
    });
    res.json({ ok: true });
  }));

  router.post('/:id/fin', handle(async (req, res) => {
    const result = await endExpense(pool, { expenseId: readId(req.params.id), month: readMonth(req.body?.month) });
    res.json({ ok: true, data: result });
  }));

  // Subida de un archivo: el cuerpo es el archivo tal cual; el nombre va en X-File-Name.
  router.post(
    '/:id/archivos',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
    handle(async (req, res) => {
      const id = await addFile(pool, {
        expenseId: readId(req.params.id),
        month: readMonth(req.query.mes),
        kind: readFileKind(req.query.tipo),
        filename: req.get('X-File-Name'),
        mime: req.get('Content-Type'),
        data: req.body,
        userId: req.user.id,
      });
      res.status(201).json({ ok: true, data: { id } });
    }),
  );

  // Un archivo de más de 10 MB lo corta express.raw antes de llegar a la ruta.
  router.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'El archivo supera los 10 MB.', code: 'FILE_TOO_LARGE' });
    }
    return next(error);
  });
  router.use(httpErrorHandler);
  return router;
}
