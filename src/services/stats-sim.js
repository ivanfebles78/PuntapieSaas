import { daysBetween, weekday } from './stats.js';

// Simulación verosímil de ventas de una zapatería infantil, solo para ver
// cómo quedarán las estadísticas cuando el TPV esté en marcha. Determinista:
// el mismo día genera siempre las mismas ventas. Nada se guarda.

const BASE_DAY_CENTS = 52000;
const AVG_TICKET_CENTS = 4600;
// Lunes … sábado; el domingo la tienda cierra.
const WEEKDAY_FACTOR = [0, 0.82, 0.9, 0.95, 0.92, 1.12, 1.38, 0];
// Enero (rebajas), septiembre (vuelta al cole), diciembre (Navidad) tiran;
// agosto flojea.
const MONTH_FACTOR = [0, 1.15, 0.85, 0.9, 0.95, 1.0, 1.05, 0.95, 0.72, 1.45, 1.1, 1.0, 1.3];
// Horario 10–14 y 17–20:30, con más gente a media mañana y a última hora.
const HOUR_WEIGHTS = [[10, 0.7], [11, 1.2], [12, 1.35], [13, 1.0], [17, 0.85], [18, 1.25], [19, 1.4], [20, 0.6]];
const METHOD_WEIGHTS = [['tarjeta', 0.63], ['efectivo', 0.17], ['bonos', 0.1], ['bizum', 0.06], ['vales', 0.04]];
const HOLIDAYS = new Set(['01-01', '01-06', '02-02', '05-01', '05-30', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25']);
const MONTHLY_EXPENSES_CENTS = 920000;

/** PRNG pequeño y reproducible (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (text) => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

function pickWeighted(random, weights) {
  const total = weights.reduce((t, [, w]) => t + w, 0);
  let roll = random() * total;
  for (const [value, weight] of weights) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return weights[weights.length - 1][0];
}

function simulateDay(day) {
  const dow = weekday(day);
  if (dow === 7 || HOLIDAYS.has(day.slice(5))) return [];
  const random = seeded(seedOf(day));
  const month = Number(day.slice(5, 7));
  const noise = 0.65 + random() * 0.7;
  const target = BASE_DAY_CENTS * WEEKDAY_FACTOR[dow] * MONTH_FACTOR[month] * noise;
  const sales = [];
  let total = 0;
  while (total < target) {
    const hour = pickWeighted(random, HOUR_WEIGHTS);
    const minute = Math.floor(random() * 60);
    // Tickets entre ~15 € y ~140 €, la mayoría alrededor de 45 €.
    const cents = Math.round((AVG_TICKET_CENTS * (0.35 + random() * random() * 2.6)) / 10) * 10;
    sales.push({
      at: `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cents,
      method: pickWeighted(random, METHOD_WEIGHTS),
    });
    total += cents;
  }
  return sales.sort((a, b) => a.at.localeCompare(b.at));
}

/** Ventas simuladas entre dos días, ambos incluidos (hoy solo hasta la hora actual). */
export function simulateSales(from, to, nowTime = '23:59') {
  return daysBetween(from, to).flatMap((day) => simulateDay(day)
    .filter((sale) => day < to || sale.at.slice(11) <= nowTime));
}

/** Gastos simulados por mes (alrededor de 9.200 €). */
export function simulateExpenses(months) {
  return Object.fromEntries(months.map((month) => {
    const random = seeded(seedOf(`gastos-${month}`));
    return [month, Math.round(MONTHLY_EXPENSES_CENTS * (0.85 + random() * 0.3))];
  }));
}
