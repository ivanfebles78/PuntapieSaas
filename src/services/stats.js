// Cálculo puro de las estadísticas de ventas. Recibe ventas ya en hora local
// de la tienda («YYYY-MM-DDTHH:MM»), los gastos por mes y los objetivos; no
// sabe si los datos son reales o simulados.

import { SHIFTS, SHIFT_CUTOFF_HOUR } from './shop-hours.js';

export { SHIFT_CUTOFF_HOUR };
export const PAYMENT_METHODS = Object.freeze(['efectivo', 'tarjeta', 'bizum', 'bonos', 'vales']);
const DAILY_CHART_DAYS = 30;
const DAY_MS = 86400000;

/* ---------- Fechas como texto ---------- */

const toTime = (day) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day, n) => new Date(toTime(day) + n * DAY_MS).toISOString().slice(0, 10);
/** 1 = lunes … 7 = domingo */
export const weekday = (day) => ((new Date(toTime(day)).getUTCDay() + 6) % 7) + 1;
export const weekStart = (day) => addDays(day, 1 - weekday(day));
const monthOf = (day) => day.slice(0, 7);

export function daysBetween(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/* ---------- Agregados ---------- */

function emptyBucket() {
  return { cents: 0, tickets: 0 };
}

function groupByDay(sales) {
  const byDay = new Map();
  for (const sale of sales) {
    const day = sale.at.slice(0, 10);
    const hour = Number(sale.at.slice(11, 13));
    const bucket = byDay.get(day) ?? { ...emptyBucket(), morning: 0, afternoon: 0 };
    bucket.cents += sale.cents;
    bucket.tickets += 1;
    if (hour < SHIFT_CUTOFF_HOUR) bucket.morning += sale.cents;
    else bucket.afternoon += sale.cents;
    byDay.set(day, bucket);
  }
  return byDay;
}

function sumBy(days, byDay, keyOf) {
  const groups = new Map();
  for (const day of days) {
    const key = keyOf(day);
    const bucket = groups.get(key) ?? emptyBucket();
    const sales = byDay.get(day);
    if (sales) {
      bucket.cents += sales.cents;
      bucket.tickets += sales.tickets;
    }
    groups.set(key, bucket);
  }
  return groups;
}

function weekdayAverages(days, byDay) {
  const rows = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, totalCents: 0, days: 0 }));
  for (const day of days) {
    const sales = byDay.get(day);
    if (!sales) continue; // sin ventas = cerrado o festivo: no cuenta en la media
    const row = rows[weekday(day) - 1];
    row.totalCents += sales.cents;
    row.days += 1;
  }
  const result = rows.map((r) => ({ weekday: r.weekday, days: r.days, avgCents: r.days ? Math.round(r.totalCents / r.days) : 0 }));
  const open = result.filter((r) => r.days > 0);
  const best = open.reduce((a, b) => (b.avgCents > (a?.avgCents ?? -1) ? b : a), null);
  const worst = open.reduce((a, b) => (b.avgCents < (a?.avgCents ?? Infinity) ? b : a), null);
  return { rows: result, best: best?.weekday ?? null, worst: worst?.weekday ?? null };
}

function paymentMethods(sales) {
  const total = sales.reduce((t, s) => t + s.cents, 0);
  return PAYMENT_METHODS.map((id) => {
    const list = sales.filter((s) => s.method === id);
    const cents = list.reduce((t, s) => t + s.cents, 0);
    return { id, cents, count: list.length, share: total ? cents / total : 0 };
  });
}

function shifts(sales, byDay) {
  const result = {
    manana: { ...emptyBucket(), daysWon: 0, start: SHIFTS.manana.start, end: SHIFTS.manana.end },
    tarde: { ...emptyBucket(), daysWon: 0, start: SHIFTS.tarde.start, end: SHIFTS.tarde.end },
    cutoffHour: SHIFT_CUTOFF_HOUR,
  };
  for (const sale of sales) {
    const target = Number(sale.at.slice(11, 13)) < SHIFT_CUTOFF_HOUR ? result.manana : result.tarde;
    target.cents += sale.cents;
    target.tickets += 1;
  }
  for (const day of byDay.values()) {
    if (day.morning > day.afternoon) result.manana.daysWon += 1;
    else if (day.afternoon > day.morning) result.tarde.daysWon += 1;
  }
  return result;
}

function hours(sales, openDays) {
  const byHour = new Map();
  for (const sale of sales) {
    const hour = Number(sale.at.slice(11, 13));
    const bucket = byHour.get(hour) ?? emptyBucket();
    bucket.cents += sale.cents;
    bucket.tickets += 1;
    byHour.set(hour, bucket);
  }
  if (byHour.size === 0) return { rows: [], best: null, worst: null };
  const first = Math.min(...byHour.keys());
  const last = Math.max(...byHour.keys());
  const rows = [];
  for (let hour = first; hour <= last; hour += 1) {
    const b = byHour.get(hour) ?? emptyBucket();
    rows.push({ hour, cents: b.cents, tickets: b.tickets, avgPerDayCents: openDays ? Math.round(b.cents / openDays) : 0 });
  }
  const withSales = rows.filter((r) => r.cents > 0);
  const best = withSales.reduce((a, b) => (b.cents > a.cents ? b : a), withSales[0]);
  const worst = withSales.reduce((a, b) => (b.cents < a.cents ? b : a), withSales[0]);
  return { rows, best: best?.hour ?? null, worst: worst?.hour ?? null };
}

/* ---------- Objetivos ---------- */

/** Solo cuentan los periodos ya cerrados (antes de hoy) y con la tienda abierta. */
function goals({ days, byDay, today, targets }) {
  const closedDays = days.filter((d) => d < today && byDay.has(d));
  const dayGoal = { met: closedDays.filter((d) => byDay.get(d).cents >= targets.dailyCents).length, total: closedDays.length };

  const weeks = sumBy(days.filter((d) => weekStart(d) < weekStart(today)), byDay, weekStart);
  const fullWeeks = [...weeks.entries()].filter(([start]) => start >= days[0]);
  const weekGoal = { met: fullWeeks.filter(([, b]) => b.cents >= targets.weeklyCents).length, total: fullWeeks.length };

  const months = sumBy(days.filter((d) => monthOf(d) < monthOf(today)), byDay, monthOf);
  const fullMonths = [...months.entries()].filter(([month]) => `${month}-01` >= days[0]);
  const monthGoal = { met: fullMonths.filter(([, b]) => b.cents >= targets.monthlyCents).length, total: fullMonths.length };

  return { days: dayGoal, weeks: weekGoal, months: monthGoal };
}

/* ---------- Entrada principal ---------- */

/**
 * @param {object} input
 * @param {{at: string, cents: number, method: string}[]} input.sales  ventas en hora local
 * @param {Record<string, number>} input.expensesByMonth  «YYYY-MM» → céntimos
 * @param {{dailyCents: number, weeklyCents: number, monthlyCents: number}} input.targets
 * @param {string} input.from  primer día del periodo
 * @param {string} input.today  hoy (último día del periodo)
 */
export function computeStats({ sales, expensesByMonth = {}, targets, from, today }) {
  const days = daysBetween(from, today);
  const byDay = groupByDay(sales);
  const openDays = [...byDay.keys()].length;
  const sum = (list) => list.reduce((t, d) => t + (byDay.get(d)?.cents ?? 0), 0);

  const thisWeek = days.filter((d) => weekStart(d) === weekStart(today));
  const thisMonth = days.filter((d) => monthOf(d) === monthOf(today));
  const totalCents = sum(days);
  const tickets = sales.length;

  const weekly = [...sumBy(days, byDay, weekStart).entries()].map(([start, b]) => ({ weekStart: start, ...b }));
  const monthly = [...sumBy(days, byDay, monthOf).entries()].map(([month, b]) => {
    const expensesCents = expensesByMonth[month] ?? 0;
    return {
      month,
      salesCents: b.cents,
      tickets: b.tickets,
      expensesCents,
      profitCents: b.cents - expensesCents,
      targetMet: b.cents >= targets.monthlyCents,
      complete: month < monthOf(today),
    };
  });

  return {
    period: { from, to: today },
    targets,
    kpis: {
      today: { cents: byDay.get(today)?.cents ?? 0, targetCents: targets.dailyCents },
      week: { cents: sum(thisWeek), targetCents: targets.weeklyCents },
      month: { cents: sum(thisMonth), targetCents: targets.monthlyCents },
      total: { cents: totalCents, tickets, openDays, avgTicketCents: tickets ? Math.round(totalCents / tickets) : 0 },
    },
    goals: goals({ days, byDay, today, targets }),
    daily: days.slice(-DAILY_CHART_DAYS).map((day) => ({ day, cents: byDay.get(day)?.cents ?? 0, tickets: byDay.get(day)?.tickets ?? 0 })),
    weekly,
    monthly,
    weekdays: weekdayAverages(days, byDay),
    methods: paymentMethods(sales),
    shifts: shifts(sales, byDay),
    hours: hours(sales, openDays),
  };
}
