import { HttpError } from '../http-error.js';
import { previousMonth } from './money.js';

export const KINDS = Object.freeze(['fijo', 'variable']);
export const STATUSES = Object.freeze(['pendiente', 'pagado']);
const MAX_NAME_LENGTH = 80;

export function readName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Escribe el concepto del gasto.', 'INVALID_NAME');
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `El concepto no puede superar ${MAX_NAME_LENGTH} caracteres.`, 'INVALID_NAME');
  }
  return name;
}

export function readKind(value) {
  if (!KINDS.includes(value)) throw new HttpError(400, 'El tipo debe ser «fijo» o «variable».', 'INVALID_KIND');
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
async function findActive(db, expenseId, month) {
  const result = await db.query(
    `SELECT id, kind, to_char(start_month, 'YYYY-MM-DD') AS start_month,
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

/* ---------- Vista de un mes ---------- */

function toFile(row) {
  return { id: row.id, kind: row.kind, filename: row.filename, mime: row.mime, size: row.size_bytes, uploadedAt: row.uploaded_at };
}

function toItem(row, files) {
  const fixedAmount = row.kind === 'fijo' ? row.base_amount ?? 0 : 0;
  const hasOverride = row.amount_cents !== null && row.amount_cents !== undefined;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    startMonth: row.start_month.slice(0, 7),
    amountCents: hasOverride ? row.amount_cents : fixedAmount,
    // 'mes': escrito para este mes; 'fijo': el importe fijo vigente; 'vacio': variable sin importe.
    amountSource: hasOverride ? 'mes' : row.kind === 'fijo' ? 'fijo' : 'vacio',
    fixedAmountCents: row.kind === 'fijo' ? fixedAmount : null,
    status: row.status ?? 'pendiente',
    paidAt: row.paid_at ?? null,
    invoices: files.filter((f) => f.kind === 'factura'),
    receipts: files.filter((f) => f.kind === 'justificante'),
  };
}

export async function monthView(pool, month) {
  const result = await pool.query(
    `SELECT e.id, e.name, e.kind, to_char(e.start_month, 'YYYY-MM-DD') AS start_month,
            (SELECT a.amount_cents FROM recurring_amounts a
              WHERE a.expense_id = e.id AND a.from_month <= $1
              ORDER BY a.from_month DESC LIMIT 1) AS base_amount,
            en.id AS entry_id, en.amount_cents, en.status, en.paid_at
       FROM recurring_expenses e
       LEFT JOIN recurring_entries en ON en.expense_id = e.id AND en.month = $1
      WHERE e.start_month <= $1 AND (e.end_month IS NULL OR e.end_month >= $1)
      ORDER BY CASE e.kind WHEN 'fijo' THEN 0 ELSE 1 END, lower(e.name), e.id`,
    [month],
  );
  const entryIds = result.rows.map((r) => r.entry_id).filter(Boolean);
  const files = entryIds.length === 0 ? [] : (await pool.query(
    `SELECT id, entry_id, kind, filename, mime, size_bytes, uploaded_at
       FROM expense_files WHERE entry_id = ANY($1::int[]) ORDER BY uploaded_at, id`,
    [entryIds],
  )).rows;

  const items = result.rows.map((row) => toItem(row, files.filter((f) => f.entry_id === row.entry_id).map(toFile)));
  const sum = (list) => list.reduce((total, item) => total + item.amountCents, 0);
  return {
    month: month.slice(0, 7),
    items,
    totals: {
      totalCents: sum(items),
      paidCents: sum(items.filter((i) => i.status === 'pagado')),
      pendingCents: sum(items.filter((i) => i.status === 'pendiente')),
      count: items.length,
      pendingCount: items.filter((i) => i.status === 'pendiente').length,
    },
  };
}

/* ---------- Cambios ---------- */

/**
 * Alta de un gasto desde `startMonth`. En los fijos el importe se arrastra
 * a los meses siguientes; en los variables solo cuenta para su primer mes.
 */
export async function createExpense(pool, { name, kind, amountCents, startMonth, userId }) {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO recurring_expenses (name, kind, start_month, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, kind, startMonth, userId],
    );
    const id = inserted.rows[0].id;
    if (kind === 'fijo') {
      await client.query(
        'INSERT INTO recurring_amounts (expense_id, from_month, amount_cents) VALUES ($1, $2, $3)',
        [id, startMonth, amountCents ?? 0],
      );
    } else if (amountCents) {
      await client.query(
        'INSERT INTO recurring_entries (expense_id, month, amount_cents) VALUES ($1, $2, $3)',
        [id, startMonth, amountCents],
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
 * respetan); scope 'mes' lo cambia solo ese mes. En los variables siempre es
 * el importe del mes.
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
 * Deja de contar el gasto a partir de `month`. Si empezaba ese mismo mes,
 * se borra entero (con sus facturas y justificantes).
 */
export async function endExpense(pool, { expenseId, month }) {
  const expense = await findActive(pool, expenseId, month);
  if (expense.start_month === month) {
    await pool.query('DELETE FROM recurring_expenses WHERE id = $1', [expenseId]);
    return { deleted: true };
  }
  await pool.query('UPDATE recurring_expenses SET end_month = $2 WHERE id = $1', [expenseId, previousMonth(month)]);
  // Lo apuntado en meses que ya no cuentan desaparece con el gasto.
  await pool.query('DELETE FROM recurring_entries WHERE expense_id = $1 AND month >= $2', [expenseId, month]);
  return { deleted: false };
}

export { findActive };
