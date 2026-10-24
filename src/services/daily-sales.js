import { HttpError } from '../http-error.js';
import { readCents, readDay } from './money.js';
import { SHIFT_IDS } from './shop-hours.js';
import { PAYMENT_METHODS } from './stats.js';

// Caja diaria: ventas por día, turno y método (importe y clientes) mientras
// no haya TPV. Se apunta la mañana y el cierre del día (total del TPV); la
// tarde es la diferencia.

const MAX_CUSTOMERS = 1000;
export const DAY_STATUSES = Object.freeze(['abierto', 'festivo', 'cerrado']);

const emptyShift = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { cents: 0, customers: 0 }]));

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

function readCustomers(value, label) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CUSTOMERS) throw new HttpError(400, `${label}: el número de clientes no es válido.`, 'INVALID_CUSTOMERS');
  return n;
}

const LABELS = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos', vales: 'Vales' });
const optionalCents = (value, label) => (value === undefined || value === null || value === '' ? 0 : readCents(value, label));

/**
 * Valida lo que llega de la pantalla: { status, manana: {metodo: {importe, clientes}},
 * dia: {metodo: {importe}}, tarde: {metodo: {clientes}} }. Devuelve los dos turnos ya
 * calculados (tarde = total del día − mañana).
 */
export function readDayInput(body) {
  const status = body?.status ?? 'abierto';
  if (!DAY_STATUSES.includes(status)) throw new HttpError(400, 'Estado del día no válido.', 'INVALID_STATUS');
  const manana = emptyShift();
  const tarde = emptyShift();
  if (status !== 'abierto') return { status, manana, tarde };
  for (const m of PAYMENT_METHODS) {
    const label = LABELS[m];
    manana[m] = {
      cents: optionalCents(body?.manana?.[m]?.importe, `${label} de la mañana`),
      customers: readCustomers(body?.manana?.[m]?.clientes, `${label} de la mañana`),
    };
    const total = optionalCents(body?.dia?.[m]?.importe, `Total del día en ${label.toLowerCase()}`);
    if (total < manana[m].cents) {
      throw new HttpError(400, `${label}: el total del día (TPV) no puede ser menor que lo de la mañana.`, 'DAY_BELOW_MORNING');
    }
    tarde[m] = { cents: total - manana[m].cents, customers: readCustomers(body?.tarde?.[m]?.clientes, `${label} de la tarde`) };
  }
  return { status, manana, tarde };
}

function shape(day, row, lines) {
  const shifts = { manana: emptyShift(), tarde: emptyShift() };
  for (const l of lines) shifts[l.shift][l.method] = { cents: l.amount_cents, customers: l.customers };
  const sum = (shift, key, revenueOnly = true) => PAYMENT_METHODS
    .filter((m) => !revenueOnly || m !== 'vales')
    .reduce((t, m) => t + shifts[shift][m][key], 0);
  return {
    day,
    exists: Boolean(row),
    status: row?.status ?? 'abierto',
    extendedHours: row?.extended_hours ?? false,
    updatedAt: row?.updated_at ?? null,
    manana: shifts.manana,
    tarde: shifts.tarde,
    // Totales de facturación: sin vales (vienen de devoluciones ya contadas).
    totals: {
      manana: { cents: sum('manana', 'cents'), customers: sum('manana', 'customers') },
      tarde: { cents: sum('tarde', 'cents'), customers: sum('tarde', 'customers') },
      vales: { cents: shifts.manana.vales.cents + shifts.tarde.vales.cents, customers: shifts.manana.vales.customers + shifts.tarde.vales.customers },
    },
  };
}

export async function getDay(db, day) {
  const row = (await db.query('SELECT status, extended_hours, updated_at FROM sales_days WHERE day = $1', [day])).rows[0];
  const lines = (await db.query('SELECT shift, method, amount_cents, customers FROM daily_sales WHERE day = $1', [day])).rows;
  return shape(day, row, lines);
}

/** Días con datos de un periodo, con su total (para la lista de la pantalla). */
export async function listDays(db, from, to) {
  const rows = (await db.query(`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.status, d.extended_hours,
           COALESCE(sum(s.amount_cents) FILTER (WHERE s.method <> 'vales'), 0)::int AS cents,
           COALESCE(sum(s.customers) FILTER (WHERE s.method <> 'vales'), 0)::int AS customers
      FROM sales_days d LEFT JOIN daily_sales s ON s.day = d.day
     WHERE d.day BETWEEN $1 AND $2
     GROUP BY d.day ORDER BY d.day DESC`, [from, to])).rows;
  return rows.map((r) => ({ day: r.day, status: r.status, extendedHours: r.extended_hours, cents: r.cents, customers: r.customers }));
}

async function writeDay(db, day, { status, manana, tarde, extendedHours, legacyId = null }, userId) {
  await db.query(
    `INSERT INTO sales_days (day, status, extended_hours, legacy_id, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (day) DO UPDATE SET status = EXCLUDED.status, extended_hours = COALESCE($3, sales_days.extended_hours),
       legacy_id = COALESCE(sales_days.legacy_id, EXCLUDED.legacy_id), updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [day, status, extendedHours ?? false, legacyId, userId],
  );
  await db.query('DELETE FROM daily_sales WHERE day = $1', [day]);
  for (const [shift, lines] of [['manana', manana], ['tarde', tarde]]) {
    for (const m of PAYMENT_METHODS) {
      const { cents, customers } = lines[m];
      if (!cents && !customers) continue;
      await db.query(
        'INSERT INTO daily_sales (day, shift, method, amount_cents, customers) VALUES ($1, $2, $3, $4, $5)',
        [day, shift, m, cents, customers],
      );
    }
  }
}

/** Guarda un día completo. Devuelve { before, after } para el log. */
export async function saveDay(pool, dayText, body, userId) {
  const day = readDay(dayText);
  const input = readDayInput(body);
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`caja:${day}`]);
    const before = await getDay(client, day);
    await writeDay(client, day, { ...input, extendedHours: body?.extendedHours === true ? true : body?.extendedHours === false ? false : null }, userId);
    return { before, after: await getDay(client, day) };
  });
}

/** Cambios entre dos versiones de un día, en texto, para el log. */
export function diffDay(before, after) {
  const eur = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
  const changes = [];
  if (before.status !== after.status) changes.push({ field: 'Día', from: before.exists ? before.status : null, to: after.status });
  for (const shift of SHIFT_IDS) {
    for (const m of PAYMENT_METHODS) {
      const a = before[shift][m];
      const b = after[shift][m];
      if (a.cents === b.cents && a.customers === b.customers) continue;
      changes.push({
        field: `${shift === 'manana' ? 'Mañana' : 'Tarde'} · ${LABELS[m]}`,
        from: a.cents || a.customers ? `${eur(a.cents)} · ${a.customers} clientes` : null,
        to: b.cents || b.customers ? `${eur(b.cents)} · ${b.customers} clientes` : null,
      });
    }
  }
  return changes;
}

export { writeDay, withTransaction, emptyShift };
