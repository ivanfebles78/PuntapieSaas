import { HttpError } from '../http-error.js';
import { listExpenses } from './expenses.js';
import { readCents } from './money.js';
import { computeStats } from './stats.js';
import { simulateExpenses, simulateSales } from './stats-sim.js';

const SHOP_TIME_ZONE = 'Atlantic/Canary';
const TARGETS_KEY = 'sales_targets';
export const DEFAULT_TARGETS = Object.freeze({ dailyCents: 50000, weeklyCents: 300000, monthlyCents: 1200000 });
export const PERIODS = Object.freeze({ '3m': 3, '6m': 6, '12m': 12, anio: null });

/** Fecha y hora actuales en la tienda: { day: 'YYYY-MM-DD', time: 'HH:MM' }. */
export function nowInShop(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Primer día del periodo: N meses naturales hasta el actual, o el año en curso. */
export function periodStart(period, today) {
  if (!(period in PERIODS)) throw new HttpError(400, 'Periodo no válido (3m, 6m, 12m o anio).', 'INVALID_PERIOD');
  const [year, month] = today.split('-').map(Number);
  if (PERIODS[period] === null) return `${year}-01-01`;
  const start = new Date(Date.UTC(year, month - PERIODS[period], 1));
  return start.toISOString().slice(0, 10);
}

/* ---------- Objetivos ---------- */

export async function getTargets(pool) {
  const result = await pool.query('SELECT value FROM settings WHERE key = $1', [TARGETS_KEY]);
  return { ...DEFAULT_TARGETS, ...(result.rows[0]?.value ?? {}) };
}

export function readTargets(body) {
  const targets = {
    dailyCents: readCents(body?.daily, 'El objetivo diario'),
    weeklyCents: readCents(body?.weekly, 'El objetivo semanal'),
    monthlyCents: readCents(body?.monthly, 'El objetivo mensual'),
  };
  if (Object.values(targets).some((v) => v <= 0)) {
    throw new HttpError(400, 'Los objetivos deben ser mayores que 0.', 'INVALID_TARGET');
  }
  return targets;
}

export async function saveTargets(pool, targets, userId) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [TARGETS_KEY, JSON.stringify(targets), userId],
  );
  return targets;
}

/* ---------- Datos reales ---------- */

async function realSales(pool, from, to) {
  const result = await pool.query(
    `SELECT to_char(sold_at AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI') AS at, total_cents, payment_method
       FROM sales
      WHERE sold_at >= ($1::date)::timestamp AT TIME ZONE $3
        AND sold_at < (($2::date + 1))::timestamp AT TIME ZONE $3
      ORDER BY sold_at`,
    [from, to, SHOP_TIME_ZONE],
  );
  return result.rows.map((r) => ({ at: r.at, cents: r.total_cents, method: r.payment_method }));
}

async function realExpensesByMonth(pool, from, to) {
  const { items } = await listExpenses(pool, from.slice(0, 7) + '-01', to.slice(0, 7) + '-01');
  const byMonth = {};
  for (const item of items) byMonth[item.month] = (byMonth[item.month] ?? 0) + item.amountCents;
  return byMonth;
}

/**
 * Estadísticas del periodo. Con `simulate`, ventas y gastos se generan al
 * vuelo (los objetivos sí son los reales); sin él, salen de la base de datos.
 */
export async function salesStats(pool, { period = '12m', simulate = false, now = new Date() } = {}) {
  const { day: today, time } = nowInShop(now);
  const from = periodStart(period, today);
  const targets = await getTargets(pool);
  const sales = simulate ? simulateSales(from, today, time) : await realSales(pool, from, today);
  const expensesByMonth = simulate
    ? simulateExpenses(monthsList(from, today))
    : await realExpensesByMonth(pool, from, today);
  return { simulated: simulate, period, hasRealSales: simulate ? null : sales.length > 0, ...computeStats({ sales, expensesByMonth, targets, from, today }) };
}

function monthsList(from, to) {
  const months = [];
  const [y, m] = from.split('-').map(Number);
  for (let i = 0; ; i += 1) {
    const month = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7);
    if (month > to.slice(0, 7)) return months;
    months.push(month);
  }
}
