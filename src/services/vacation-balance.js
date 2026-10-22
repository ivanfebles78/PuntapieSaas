// Cálculo del saldo de vacaciones de un año natural. Todo con fechas
// «YYYY-MM-DD» en UTC para que ni la zona horaria ni el horario de verano
// muevan un día.

export const ANNUAL_VACATION_DAYS = 30;
// Primer año con vacaciones registradas en la aplicación: los anteriores no
// tienen datos, así que sus días pendientes se escriben a mano.
export const VACATION_TRACKING_SINCE = 2026;
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
 * Días de vacaciones dentro de `year`, separados en disfrutados (hasta
 * `today` incluido) y programados (después). Los periodos que cruzan de año
 * solo cuentan la parte de ese año.
 */
function usedInYear(periods, year, today) {
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
  return { taken, planned };
}

/**
 * Días sin gastar del año anterior que pasan a `year`.
 *
 * Regla: solo pasan los días propios del año anterior. Los que ese año
 * traía arrastrados caducan, así que se gastan primero:
 *   propios sin gastar = corresponden − max(0, usados − arrastrados).
 * Se calcula año a año desde que se registran vacaciones en la aplicación;
 * para años sin datos (o para corregir) vale el número escrito a mano.
 * `manualByYear` es { [año]: días pendientes que entran en ese año }.
 */
export function carryOverDays({ contractStart, periods, year, manualByYear = {} }) {
  const manual = manualByYear[year];
  if (manual !== null && manual !== undefined) return { days: manual, source: 'manual' };
  const previous = year - 1;
  if (previous < VACATION_TRACKING_SINCE) return { days: 0, source: 'none' };
  if (contractStart && contractStart > `${previous}-12-31`) return { days: 0, source: 'auto' };
  const carriedIntoPrevious = carryOverDays({ contractStart, periods, year: previous, manualByYear }).days;
  const used = usedInYear(periods, previous, `${previous}-12-31`).taken;
  const ownUsed = Math.max(0, used - carriedIntoPrevious);
  const unused = entitledDays(contractStart, previous).days - ownUsed;
  return { days: Math.max(0, unused), source: 'auto' };
}

/**
 * Saldo del año de `today`: días que corresponden, pendientes del año
 * anterior, disfrutados (hasta hoy incluido), programados (a partir de
 * mañana) y los que quedan.
 */
export function vacationBalance({ contractStart, periods, today = todayInShop(), manualByYear = {} }) {
  const year = Number(today.slice(0, 4));
  const { taken, planned } = usedInYear(periods, year, today);
  const entitled = entitledDays(contractStart, year);
  const carry = carryOverDays({ contractStart, periods, year, manualByYear });
  const available = entitled.days + carry.days;
  return {
    year,
    contractStart: contractStart ?? null,
    entitled: entitled.days,
    prorated: entitled.prorated,
    workedDays: entitled.workedDays,
    carryOver: carry.days,
    carryOverSource: carry.source,
    available,
    taken,
    planned,
    remaining: available - taken - planned,
  };
}
