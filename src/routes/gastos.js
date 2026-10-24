import express, { Router } from 'express';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { MAX_FILE_BYTES, addFile, deleteFile, getFile, readFileKind } from '../services/expense-files.js';
import { auditFrom } from '../services/audit.js';
import { buildExpensesExport, writeZip } from '../services/exports.js';
import { todayInShop } from '../services/vacation-balance.js';
import { formatEuros, readCents, readDay, readMonth } from '../services/money.js';
import {
  createExpense,
  endExpense,
  findExpenseItem,
  firstExpenseMonth,
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

const CATEGORY_LABELS = Object.freeze({ recurrente: 'Recurrente', esporadico: 'Esporádico', proveedor: 'Pago a proveedor' });
const KIND_LABELS = Object.freeze({ fijo: 'Fijo', variable: 'Variable', unico: 'Pago único' });
const FILE_LABELS = Object.freeze({ factura: 'Factura', justificante: 'Justificante' });
const STATUS_LABELS = Object.freeze({ pendiente: 'Pendiente', pagado: 'Pagado' });
const esMonth = (month) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
const esDay = (day) => day.split('-').reverse().join('/');
const itemTarget = (item, month) => `${item.name} · ${esMonth(month)}`;

export function gastosRouter({ pool, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);

  async function itemOrThrow(expenseId, month) {
    const item = await findExpenseItem(pool, expenseId, month);
    if (!item) throw new HttpError(409, 'Ese gasto no está activo en el mes elegido.', 'EXPENSE_INACTIVE');
    return item;
  }

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
    const removed = await deleteFile(pool, readId(req.params.fileId, 'Ese documento'));
    await audit(req, {
      area: 'gastos',
      action: 'quitar',
      target: `${removed.expenseName} · ${esMonth(removed.month)}`,
      changes: [{ field: FILE_LABELS[removed.kind], from: removed.filename, to: null }],
    });
    res.json({ ok: true });
  }));

  /* ---------- Exportar ---------- */

  // ZIP con el Excel de movimientos y todas las facturas y justificantes.
  // ?desde=AAAA-MM&hasta=AAAA-MM, o ?todo=1 para todo el historial.
  router.get('/exportar', handle(async (req, res) => {
    const current = `${todayInShop().slice(0, 7)}-01`;
    const all = req.query.todo === '1';
    const from = all ? (await firstExpenseMonth(pool)) ?? current : readMonth(req.query.desde);
    const to = all ? current : readMonth(req.query.hasta ?? req.query.desde, 'El mes final');
    const data = await buildExpensesExport(pool, { from, to });
    const span = from === to ? from.slice(0, 7) : `${from.slice(0, 7)}_a_${to.slice(0, 7)}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="puntapie_gastos_${span}.zip"`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      await writeZip(res, {
        workbook: data.workbook,
        workbookName: `gastos_${span}.xlsx`,
        files: data.files,
        readFile: async (id) => (await getFile(pool, id)).data,
        readme: `Puntapié · Exportación de gastos (${span.replace('_a_', ' a ')})\r\n\r\n`
          + `- gastos_${span}.xlsx: todos los movimientos (hoja «Gastos») y el resumen por mes.\r\n`
          + '- facturas/ y justificantes/: los documentos, por mes y concepto. Las celdas del Excel enlazan a cada archivo.\r\n',
      });
      await audit(req, {
        area: 'gastos',
        action: 'exportar',
        target: all ? 'Todo el historial' : `${esMonth(from)}${from === to ? '' : ` – ${esMonth(to)}`}`,
        changes: [{ field: 'Contenido', from: null, to: `${data.count} movimientos y ${data.files.length} documentos` }],
      });
    } catch (error) {
      log.error('[gastos] Exportación interrumpida:', error.message);
      res.destroy(error);
    }
  }));

  /* ---------- Gastos ---------- */

  // ?mes=AAAA-MM, o ?desde=AAAA-MM&hasta=AAAA-MM para varios meses.
  router.get('/', handle(async (req, res) => {
    const from = readMonth(req.query.desde ?? req.query.mes);
    const to = req.query.hasta ? readMonth(req.query.hasta, 'El mes final') : from;
    res.json({ ok: true, data: await listExpenses(pool, from, to) });
  }));

  router.post('/', handle(async (req, res) => {
    const expense = readNewExpense(req.body);
    const id = await createExpense(pool, { ...expense, userId: req.user.id });
    await audit(req, {
      area: 'gastos',
      action: 'crear',
      target: expense.name,
      changes: [
        { field: 'Tipo', from: null, to: CATEGORY_LABELS[expense.category] },
        ...(expense.category === 'recurrente'
          ? [{ field: 'Forma', from: null, to: KIND_LABELS[expense.kind] }, { field: 'Desde', from: null, to: esMonth(expense.startMonth) }]
          : [{ field: 'Fecha', from: null, to: esDay(expense.date) }]),
        { field: 'Importe', from: null, to: formatEuros(expense.amountCents ?? 0) },
      ],
    });
    res.status(201).json({ ok: true, data: { id } });
  }));

  router.patch('/:id', handle(async (req, res) => {
    const id = readId(req.params.id);
    const name = readName(req.body?.name);
    const before = await pool.query('SELECT name FROM recurring_expenses WHERE id = $1', [id]);
    await renameExpense(pool, id, name);
    if (before.rows[0].name !== name) {
      await audit(req, { area: 'gastos', action: 'editar', target: name, changes: [{ field: 'Concepto', from: before.rows[0].name, to: name }] });
    }
    res.json({ ok: true });
  }));

  router.put('/:id/importe', handle(async (req, res) => {
    const change = {
      expenseId: readId(req.params.id),
      month: readMonth(req.body?.month),
      amountCents: readCents(req.body?.amount),
      scope: req.body?.scope === 'desde' ? 'desde' : 'mes',
    };
    const before = await itemOrThrow(change.expenseId, change.month);
    await setAmount(pool, change);
    if (before.amountCents !== change.amountCents || before.amountSource === 'vacio') {
      await audit(req, {
        area: 'gastos',
        action: 'editar',
        target: itemTarget(before, change.month),
        changes: [{ field: before.kind === 'fijo' && change.scope === 'desde' ? 'Importe (desde este mes)' : 'Importe', from: formatEuros(before.amountCents), to: formatEuros(change.amountCents) }],
      });
    }
    res.json({ ok: true });
  }));

  router.put('/:id/estado', handle(async (req, res) => {
    const change = { expenseId: readId(req.params.id), month: readMonth(req.body?.month), status: readStatus(req.body?.status) };
    const before = await itemOrThrow(change.expenseId, change.month);
    await setStatus(pool, change);
    if (before.status !== change.status) {
      await audit(req, {
        area: 'gastos',
        action: 'editar',
        target: itemTarget(before, change.month),
        changes: [{ field: 'Estado', from: STATUS_LABELS[before.status], to: STATUS_LABELS[change.status] }],
      });
    }
    res.json({ ok: true });
  }));

  router.post('/:id/fin', handle(async (req, res) => {
    const change = { expenseId: readId(req.params.id), month: readMonth(req.body?.month) };
    const before = await itemOrThrow(change.expenseId, change.month);
    const result = await endExpense(pool, change);
    await audit(req, {
      area: 'gastos',
      action: 'borrar',
      target: itemTarget(before, change.month),
      changes: [result.deleted
        ? { field: 'Gasto', from: `${before.name} (${formatEuros(before.amountCents)})`, to: null }
        : { field: 'Deja de repetirse desde', from: null, to: esMonth(change.month) }],
    });
    res.json({ ok: true, data: result });
  }));

  // Subida de un archivo: el cuerpo es el archivo tal cual; el nombre va en X-File-Name.
  router.post(
    '/:id/archivos',
    express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }),
    handle(async (req, res) => {
      const upload = {
        expenseId: readId(req.params.id),
        month: readMonth(req.query.mes),
        kind: readFileKind(req.query.tipo),
        filename: req.get('X-File-Name'),
        mime: req.get('Content-Type'),
        data: req.body,
        userId: req.user.id,
      };
      const before = await itemOrThrow(upload.expenseId, upload.month);
      const id = await addFile(pool, upload);
      const file = await pool.query('SELECT filename FROM expense_files WHERE id = $1', [id]);
      await audit(req, {
        area: 'gastos',
        action: 'subir',
        target: itemTarget(before, upload.month),
        changes: [
          { field: FILE_LABELS[upload.kind], from: null, to: file.rows[0].filename },
          ...(upload.kind === 'justificante' && before.status !== 'pagado' ? [{ field: 'Estado', from: 'Pendiente', to: 'Pagado' }] : []),
        ],
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
