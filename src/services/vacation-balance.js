// Cálculo del saldo de vacaciones de un año natural. Todo con fechas
// «YYYY-MM-DD» en UTC para que ni la zona horaria ni el horario de verano
// muevan un día.

export const ANNUAL_VACATION_DAYS = 30;
const DAY_MS = 86400000;
const SHOP_TIME_ZONE = 'Atlantic/Canary';

function toTime(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

function daysBetween(fromIso, toIso) {
  return Math.round((toTime(toIso) - toTime(fromIso)) / DAY_MS) + 1;
}

function addDays(iso, days) {
  return new Date(toTime(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

const maxIso = (a, b) => (a > b ? a : b);
const minIso = (a, b) => (a < b ? a : b);

/** Fecha de hoy en la tienda (Canarias), como «YYYY-MM-DD». */
export function todayInShop(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TIME_ZONE }).format(now);
}

/**
 * Días que corresponden en `year`: 30 naturales si el contrato empezó antes
 * de ese año (o no consta); si empezó durante el año, la parte proporcional
 * de los días que quedan hasta el 31 de diciembre, redondeada al alza.
 * Ej.: inicio el 07/07 → 178 de 365 días → 14,6 → 15 días.
 */
export function entitledDays(contractStart, year, annual = ANNUAL_VACATION_DAYS) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (!contractStart || contractStart <= yearStart) return { days: annual, prorated: false, workedDays: null };
  if (contractStart > yearEnd) return { days: 0, prorated: true, workedDays: 0 };
  const workedDays = daysBetween(contractStart, yearEnd);
  const exact = (annual * workedDays) / daysBetween(yearStart, yearEnd);
  // El épsilon evita que un error de coma flotante suba un día de más.
  return { days: Math.ceil(exact - 1e-9), prorated: true, workedDays, exact };
}

/**
 * Saldo del año de `today`: días que corresponden, disfrutados (hasta hoy
 * incluido), programados (a partir de mañana) y los que quedan. Los periodos
 * que cruzan de año solo cuentan la parte de este año.
 */
export function vacationBalance({ contractStart, periods, today = todayInShop() }) {
  const year = Number(today.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const tomorrow = addDays(today, 1);
  let taken = 0;
  let planned = 0;

  for (const period of periods) {
    const start = maxIso(period.start, yearStart);
    const end = minIso(period.end, yearEnd);
    if (start > end) continue;
    if (start <= today) taken += daysBetween(start, minIso(end, today));
    if (end >= tomorrow) planned += daysBetween(maxIso(start, tomorrow), end);
  }

  const entitled = entitledDays(contractStart, year);
  return {
    year,
    contractStart: contractStart ?? null,
    entitled: entitled.days,
    prorated: entitled.prorated,
    workedDays: entitled.workedDays,
    taken,
    planned,
    remaining: entitled.days - taken - planned,
  };
}
