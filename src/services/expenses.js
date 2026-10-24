import { HttpError } from '../http-error.js';
import { facturasEntre } from '../proveedores/repo.js';
import { monthsBetween, previousMonth } from './money.js';

// Tipo de gasto (etiqueta de color) y forma de repetirse.
export const CATEGORIES = Object.freeze(['recurrente', 'esporadico', 'proveedor']);
export const RECURRING_KINDS = Object.freeze(['fijo', 'variable']);
export const STATUSES = Object.freeze(['pendiente', 'pagado']);
const MAX_NAME_LENGTH = 80;
export const MAX_RANGE_MONTHS = 24;

export function readName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Escribe el concepto del gasto.', 'INVALID_NAME');
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `El concepto no puede superar ${MAX_NAME_LENGTH} caracteres.`, 'INVALID_NAME');
  }
  return name;
}

export function readCategory(value) {
  if (!CATEGORIES.includes(value)) {
    throw new HttpError(400, 'El tipo debe ser recurrente, esporádico o pago a proveedor.', 'INVALID_CATEGORY');
  }
  return value;
}

export function readKind(value) {
  if (!RECURRING_KINDS.includes(value)) throw new HttpError(400, 'Un gasto recurrente es «fijo» o «variable».', 'INVALID_KIND');
  return value;
}

export function readStatus(value) {
  if (!STATUSES.includes(value)) throw new HttpError(400, 'El estado debe ser «pendiente» o «pagado».', 'INVALID_STATUS');
  return value;
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Devuelve el gasto si está activo en `month`; si no, 404/409 claros. */
export async function findActive(db, expenseId, month) {
  const result = await db.query(
    `SELECT id, kind, category, to_char(start_month, 'YYYY-MM-DD') AS start_month,
            to_char(end_month, 'YYYY-MM-DD') AS end_month
       FROM recurring_expenses WHERE id = $1`,
    [expenseId],
  );
  const expense = result.rows[0];
  if (!expense) throw new HttpError(404, 'Ese gasto no existe.', 'EXPENSE_NOT_FOUND');
  if (month < expense.start_month || (expense.end_month && month > expense.end_month)) {
    throw new HttpError(409, 'Ese gasto no está activo en el mes elegido.', 'EXPENSE_INACTIVE');
  }
  return expense;
}

/** Crea (si hace falta) la fila del mes y devuelve su id. */
export async function ensureEntry(db, expenseId, month) {
  const result = await db.query(
    `INSERT INTO recurring_entries (expense_id, month) VALUES ($1, $2)
     ON CONFLICT (expense_id, month) DO UPDATE SET expense_id = EXCLUDED.expense_id
     RETURNING id`,
    [expenseId, month],
  );
  return result.rows[0].id;
}

/* ---------- Lectura ---------- */

function toFile(row) {
  return {
    id: row.id, kind: row.kind, filename: row.filename, mime: row.mime, size: row.size_bytes, uploadedAt: row.uploaded_at,
    url: `/api/gastos/archivos/${row.id}`,
  };
}

/**
 * Una factura de proveedor (del gestor de pagos a proveedores) como fila de
 * la tabla de Gastos: una fila por factura, en el mes de su fecha. Su estado
 * y sus documentos se gestionan desde el gestor, no desde la tabla.
 */
export function invoiceItem(d) {
  const receipts = [];
  const seen = new Set();
  for (const v of d.vencimientos) {
    if (!v.pago?.archivo || seen.has(v.pago.archivo)) continue;
    seen.add(v.pago.archivo);
    receipts.push({ id: v.pago.id, kind: 'justificante', filename: v.pago.archivo_nombre, mime: null, size: null, url: `/api/proveedores/pagos/${v.pago.id}/archivo` });
  }
  const month = d.fecha.slice(0, 7);
  return {
    id: `p${d.id}`,
    docId: d.id,
    source: 'proveedor',
    month,
    name: `${d.proveedor.nombre} · Fra. ${d.numero}`,
    supplier: d.proveedor.nombre,
    number: d.numero,
    category: 'proveedor',
    kind: 'factura',
    date: d.fecha,
    startMonth: month,
    amountCents: d.total_cent,
    amountSource: 'factura',
    fixedAmountCents: null,
    status: d.estado === 'pagada' ? 'pagado' : 'pendiente',
    invoiceState: d.estado,
    paidCents: d.pagado_cent,
    pendingCents: d.pendiente_cent,
    nextDue: d.proximo_vencimiento,
    dues: d.vencimientos.map((v) => ({ date: v.fecha, amountCents: v.importe_cent, paid: Boolean(v.pago) })),
    paidAt: null,
    invoices: d.archivo ? [{ id: d.id, kind: 'factura', filename: d.archivo_nombre, mime: 'application/pdf', size: null, url: `/api/proveedores/documentos/${d.id}/archivo` }] : [],
    receipts,
  };
}

function toItem(row, month, files) {
  const fixedAmount = row.kind === 'fijo' ? row.base_amount ?? 0 : 0;
  const hasOverride = row.amount_cents !== null && row.amount_cents !== undefined;
  return {
    id: row.id,
    month: month.slice(0, 7),
    name: row.name,
    category: row.category,
    kind: row.kind,
    date: row.expense_date ?? null,
    startMonth: row.start_month.slice(0, 7),
    amountCents: hasOverride ? row.amount_cents : fixedAmount,
    // 'mes': escrito para este mes; 'fijo': el importe fijo vigente; 'vacio': aún sin importe.
    amountSource: hasOverride ? 'mes' : row.kind === 'fijo' ? 'fijo' : 'vacio',
    fixedAmountCents: row.kind === 'fijo' ? fixedAmount : null,
    status: row.status ?? 'pendiente',
    paidAt: row.paid_at ?? null,
    invoices: files.filter((f) => f.kind === 'factura'),
    receipts: files.filter((f) => f.kind === 'justificante'),
  };
}

async function monthItems(pool, month) {
  const result = await pool.query(
    `SELECT e.id, e.name, e.kind, e.category,
            to_char(e.start_month, 'YYYY-MM-DD') AS start_month,
            to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date,
            (SELECT a.amount_cents FROM recurring_amounts a
              WHERE a.expense_id = e.id AND a.from_month <= $1
              ORDER BY a.from_month DESC LIMIT 1) AS base_amount,
            en.id AS entry_id, en.amount_cents, en.status, en.paid_at
       FROM recurring_expenses e
       LEFT JOIN recurring_entries en ON en.expense_id = e.id AND en.month = $1
      WHERE e.start_month <= $1 AND (e.end_month IS NULL OR e.end_month >= $1)
      ORDER BY CASE e.category WHEN 'recurrente' THEN 0 WHEN 'proveedor' THEN 1 ELSE 2 END,
               e.expense_date NULLS FIRST, lower(e.name), e.id`,
    [month],
  );
  const entryIds = result.rows.map((r) => r.entry_id).filter(Boolean);
  const files = entryIds.length === 0 ? [] : (await pool.query(
    `SELECT id, entry_id, kind, filename, mime, size_bytes, uploaded_at
       FROM expense_files WHERE entry_id = ANY($1::int[]) ORDER BY uploaded_at, id`,
    [entryIds],
  )).rows;
  return result.rows.map((row) => toItem(row, month, files.filter((f) => f.entry_id === row.entry_id).map(toFile)));
}

// Lo pagado de cada fila: las facturas de proveedor pueden estar pagadas a medias.
const paidOf = (i) => i.paidCents ?? (i.status === 'pagado' ? i.amountCents : 0);
const pendingOf = (i) => i.pendingCents ?? (i.status === 'pagado' ? 0 : i.amountCents);

export function summarize(items) {
  const sum = (list, of = (i) => i.amountCents) => list.reduce((total, item) => total + of(item), 0);
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, sum(items.filter((i) => i.category === c))]));
  return {
    totalCents: sum(items),
    paidCents: sum(items, paidOf),
    pendingCents: sum(items, pendingOf),
    count: items.length,
    pendingCount: items.filter((i) => i.status === 'pendiente').length,
    byCategory,
  };
}

/** Primer mes con gastos («AAAA-MM-01»), o null si no hay ninguno. */
export async function firstExpenseMonth(pool) {
  const result = await pool.query("SELECT to_char(min(start_month), 'YYYY-MM-DD') AS m FROM recurring_expenses");
  return result.rows[0].m;
}

/** Un gasto tal como está en `month` (o null si no está activo ese mes). */
export async function findExpenseItem(pool, expenseId, month) {
  return (await monthItems(pool, month)).find((item) => item.id === expenseId) ?? null;
}

/**
 * Gastos de un mes o de un rango de meses (máx. 24 en pantalla; la
 * exportación pasa su propio límite), con sus totales.
 */
export async function listExpenses(pool, fromMonth, toMonth = fromMonth, { maxMonths = MAX_RANGE_MONTHS } = {}) {
  if (toMonth < fromMonth) throw new HttpError(400, 'El mes final no puede ser anterior al inicial.', 'INVALID_RANGE');
  const months = monthsBetween(fromMonth, toMonth);
  if (months.length > maxMonths) {
    throw new HttpError(400, `Como máximo ${maxMonths} meses a la vez.`, 'INVALID_RANGE');
  }
  // Facturas de proveedores del periodo: una fila por factura, en el mes de su fecha.
  const lastDay = new Date(Date.UTC(Number(toMonth.slice(0, 4)), Number(toMonth.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const invoices = (await facturasEntre(pool, fromMonth, lastDay)).map(invoiceItem)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const items = [];
  for (const month of months) {
    items.push(...(await monthItems(pool, month)), ...invoices.filter((i) => `${i.month}-01` === month));
  }
  return { from: fromMonth.slice(0, 7), to: toMonth.slice(0, 7), items, totals: summarize(items) };
}

/* ---------- Cambios ---------- */

/**
 * Alta de un gasto. Recurrente: desde `startMonth`, fijo (su importe se
 * arrastra) o variable (cada mes empieza en 0). Esporádico o proveedor: un
 * único pago en `date` con su importe.
 */
export async function createExpense(pool, { name, category, kind, amountCents, startMonth, date, userId }) {
  return withTransaction(pool, async (client) => {
    const isRecurring = category === 'recurrente';
    const month = isRecurring ? startMonth : `${date.slice(0, 7)}-01`;
    const inserted = await client.query(
      `INSERT INTO recurring_expenses (name, kind, category, start_month, end_month, expense_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name, isRecurring ? kind : 'unico', category, month, isRecurring ? null : month, isRecurring ? null : date, userId],
    );
    const id = inserted.rows[0].id;
    if (isRecurring && kind === 'fijo') {
      await client.query(
        'INSERT INTO recurring_amounts (expense_id, from_month, amount_cents) VALUES ($1, $2, $3)',
        [id, month, amountCents ?? 0],
      );
    } else if (amountCents) {
      await client.query(
        'INSERT INTO recurring_entries (expense_id, month, amount_cents) VALUES ($1, $2, $3)',
        [id, month, amountCents],
      );
    }
    return id;
  });
}

export async function renameExpense(pool, expenseId, name) {
  const result = await pool.query('UPDATE recurring_expenses SET name = $2 WHERE id = $1', [expenseId, name]);
  if (result.rowCount === 0) throw new HttpError(404, 'Ese gasto no existe.', 'EXPENSE_NOT_FOUND');
}

/**
 * Cambia el importe de `month`. En los fijos, scope 'desde' fija un nuevo
 * importe a partir de ese mes (los cambios puntuales de meses posteriores se
 * respetan); scope 'mes' lo cambia solo ese mes. Los demás, el importe del mes.
 */
export async function setAmount(pool, { expenseId, month, amountCents, scope }) {
  return withTransaction(pool, async (client) => {
    const expense = await findActive(client, expenseId, month);
    if (expense.kind === 'fijo' && scope === 'desde') {
      await client.query(
        `INSERT INTO recurring_amounts (expense_id, from_month, amount_cents) VALUES ($1, $2, $3)
         ON CONFLICT (expense_id, from_month) DO UPDATE SET amount_cents = EXCLUDED.amount_cents`,
        [expenseId, month, amountCents],
      );
      await client.query(
        'UPDATE recurring_entries SET amount_cents = NULL WHERE expense_id = $1 AND month = $2',
        [expenseId, month],
      );
      return;
    }
    const entryId = await ensureEntry(client, expenseId, month);
    await client.query('UPDATE recurring_entries SET amount_cents = $2 WHERE id = $1', [entryId, amountCents]);
  });
}

export async function setStatus(pool, { expenseId, month, status }) {
  await findActive(pool, expenseId, month);
  const entryId = await ensureEntry(pool, expenseId, month);
  await pool.query(
    `UPDATE recurring_entries
        SET status = $2, paid_at = CASE WHEN $2 = 'pagado' THEN COALESCE(paid_at, NOW()) ELSE NULL END
      WHERE id = $1`,
    [entryId, status],
  );
}

/**
 * Recurrente: deja de contar a partir de `month` (los meses anteriores no
 * cambian). Si empezaba ese mes, o es un pago único, se borra entero con sus
 * facturas y justificantes.
 */
export async function endExpense(pool, { expenseId, month }) {
  const expense = await findActive(pool, expenseId, month);
  if (expense.start_month === month) {
    await pool.query('DELETE FROM recurring_expenses WHERE id = $1', [expenseId]);
    return { deleted: true };
  }
  await pool.query('UPDATE recurring_expenses SET end_month = $2 WHERE id = $1', [expenseId, previousMonth(month)]);
  await pool.query('DELETE FROM recurring_entries WHERE expense_id = $1 AND month >= $2', [expenseId, month]);
  return { deleted: false };
}
