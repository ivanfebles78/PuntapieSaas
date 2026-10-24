import { config } from '../config.js';
import { HttpError } from '../http-error.js';
import { listExpenses } from './expenses.js';
import { readCents } from './money.js';
import { computeStats } from './stats.js';
import { simulateExpenses, simulateSales } from './stats-sim.js';
import { allSchedules } from './schedules.js';
import { buildStaffing, computeStaffStats, simulatedSchedules } from './staff-stats.js';

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

/**
 * Primer día que cuenta: el del periodo o, si es anterior, el día en que la
 * tienda pasó a ser nuestra (lo de antes era del dueño anterior).
 */
export function statsStart(period, today, businessStart = config.businessStart) {
  const from = periodStart(period, today);
  return businessStart && from < businessStart ? businessStart : from;
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
  const tickets = result.rows.map((r) => ({ at: r.at, cents: r.total_cents, method: r.payment_method }));
  // Caja diaria: cada turno y método es una «venta» con sus clientes, a una
  // hora representativa del turno (no hay hora real hasta que esté el TPV).
  const daily = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, shift, method, amount_cents, customers
       FROM daily_sales WHERE day BETWEEN $1 AND $2 ORDER BY day, shift, method`,
    [from, to],
  );
  const totals = daily.rows.map((r) => ({
    at: `${r.day}T${r.shift === 'manana' ? '11:00' : '18:00'}`,
    cents: r.amount_cents,
    method: r.method,
    count: r.customers,
    byShift: true,
  }));
  return [...tickets, ...totals].sort((a, b) => a.at.localeCompare(b.at));
}

async function realExpensesByMonth(pool, from, to) {
  const { items } = await listExpenses(pool, from.slice(0, 7) + '-01', to.slice(0, 7) + '-01', { maxMonths: 240 });
  const byMonth = {};
  for (const item of items) {
    // Los gastos con fecha anterior al inicio (p. ej. del dueño anterior) no cuentan.
    if (item.date && item.date < from) continue;
    byMonth[item.month] = (byMonth[item.month] ?? 0) + item.amountCents;
  }
  return byMonth;
}

/**
 * Estadísticas del periodo. Con `simulate`, ventas y gastos se generan al
 * vuelo (los objetivos sí son los reales); sin él, salen de la base de datos.
 */
export async function salesStats(pool, { period = 'anio', simulate = false, now = new Date() } = {}) {
  const { day: today, time } = nowInShop(now);
  const from = statsStart(period, today);
  const targets = await getTargets(pool);
  const sales = await loadSales(pool, { from, today, time, simulate });
  const expensesByMonth = simulate
    ? simulateExpenses(monthsList(from, today))
    : await realExpensesByMonth(pool, from, today);
  return { simulated: simulate, period, businessStart: config.businessStart, hasRealSales: simulate ? null : sales.length > 0, ...computeStats({ sales, expensesByMonth, targets, from, today }) };
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

function loadSales(pool, { from, today, time, simulate }) {
  return simulate ? simulateSales(from, today, time) : realSales(pool, from, today);
}

/** Datos de turnos para saber quién estaba en cada turno del periodo. */
async function loadStaffing(pool, from, simulate) {
  const users = await pool.query(
    `SELECT id, name, is_active, to_char(contract_start, 'YYYY-MM-DD') AS contract_start,
            to_char(deactivated_at AT TIME ZONE $1, 'YYYY-MM-DD') AS left_on
       FROM users
      -- Solo quien vende en tienda: Iván (administra) queda fuera.
      WHERE is_seller AND (password_hash IS NOT NULL OR is_active)
      ORDER BY lower(name), id`,
    [SHOP_TIME_ZONE],
  );
  const members = users.rows.map((u) => ({ id: u.id, name: u.name, active: u.is_active, contractStart: u.contract_start, leftOn: u.left_on }));
  let schedules = await allSchedules(pool);
  const simulatedTeam = simulate && schedules.length === 0;
  // Sin turnos definidos, la simulación inventa unos para el equipo activo.
  if (simulatedTeam) schedules = simulatedSchedules(members.filter((m) => m.active), from);
  const scheduled = new Set(schedules.map((s) => s.userId));
  const vacations = (await pool.query(
    "SELECT user_id, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM vacations",
  )).rows.map((v) => ({ userId: v.user_id, start: v.s, end: v.e }));
  const freeShifts = (await pool.query(
    "SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day, shift FROM free_shifts",
  )).rows.map((f) => ({ userId: f.user_id, day: f.day, shift: f.shift }));
  const openings = (await pool.query(
    `SELECT to_char(o.day, 'YYYY-MM-DD') AS day, o.shift, array_agg(s.user_id) AS staff
       FROM special_openings o JOIN special_opening_staff s ON s.opening_id = o.id GROUP BY o.id`,
  )).rows.map((o) => ({ day: o.day, shift: o.shift, staff: o.staff }));
  openings.forEach((o) => o.staff.forEach((id) => scheduled.add(id)));
  // Solo entra en la comparación quien tiene (o tuvo) turnos.
  const team = members.filter((m) => scheduled.has(m.id));
  return { team, simulatedTeam, staffing: buildStaffing({ members: team, schedules, vacations, freeShifts, openings }) };
}

/** Ventas por empleado según los turnos en los que estaba. */
export async function staffStats(pool, { period = 'anio', simulate = false, now = new Date() } = {}) {
  const { day: today, time } = nowInShop(now);
  const from = statsStart(period, today);
  const sales = await loadSales(pool, { from, today, time, simulate });
  const { team, simulatedTeam, staffing } = await loadStaffing(pool, from, simulate);
  return {
    simulated: simulate,
    simulatedTeam,
    period,
    from,
    to: today,
    hasRealSales: simulate ? null : sales.length > 0,
    hasSchedules: team.length > 0,
    ...computeStaffStats({ sales, members: team.map(({ id, name, active }) => ({ id, name, active })), staffing }),
  };
}

/** Todo lo necesario para exportar las ventas del periodo (reales o simuladas). */
export async function salesExportData(pool, { period = 'anio', simulate = false, now = new Date() } = {}) {
  const { day: today, time } = nowInShop(now);
  const from = statsStart(period, today);
  const sales = await loadSales(pool, { from, today, time, simulate });
  const { team, staffing } = await loadStaffing(pool, from, simulate);
  const staff = computeStaffStats({ sales, members: team.map(({ id, name, active }) => ({ id, name, active })), staffing });
  return { sales, team, staffing, staff, targets: await getTargets(pool), simulated: simulate, from, to: today };
}
