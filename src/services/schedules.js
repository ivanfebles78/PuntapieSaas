import { TeamError } from './team.js';
import { REGULAR_SLOTS, WEEKDAY_NAMES, SHIFTS } from './shop-hours.js';
import { readDate } from './vacations.js';

// Turnos fijos de cada persona, con historial: cada versión vale desde su
// fecha hasta la siguiente.

const SLOT_ORDER = new Map(REGULAR_SLOTS.map((slot, i) => [slot, i]));

export function readSlots(value) {
  if (!Array.isArray(value)) throw new TeamError(400, 'Indica los turnos como una lista.', 'INVALID_SLOTS');
  const slots = [...new Set(value.map(String))];
  const wrong = slots.find((slot) => !SLOT_ORDER.has(slot));
  if (wrong) {
    throw new TeamError(400, 'Solo se pueden elegir turnos del horario normal (lunes a viernes mañana y tarde, sábado mañana).', 'INVALID_SLOTS');
  }
  return slots.sort((a, b) => SLOT_ORDER.get(a) - SLOT_ORDER.get(b));
}

/** «Lunes mañana, Lunes tarde…» para el log y los resúmenes. */
export function describeSlots(slots) {
  if (!slots.length) return 'Sin turnos';
  return slots.map((slot) => {
    const [day, shift] = slot.split('-');
    return `${WEEKDAY_NAMES[Number(day)]} ${SHIFTS[shift].label.toLowerCase()}`;
  }).join(', ');
}

function toVersion(row) {
  return { validFrom: row.valid_from, slots: row.slots ?? [] };
}

/** Turno vigente en `day` y el historial completo (lo más reciente primero). */
export async function getSchedule(pool, userId, day) {
  const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (user.rowCount === 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
  const result = await pool.query(
    `SELECT to_char(valid_from, 'YYYY-MM-DD') AS valid_from, slots
       FROM work_schedules WHERE user_id = $1 ORDER BY valid_from DESC`,
    [userId],
  );
  const history = result.rows.map(toVersion);
  const current = history.find((v) => v.validFrom <= day) ?? null;
  const upcoming = history.filter((v) => v.validFrom > day).reverse();
  return { current, upcoming, history };
}

/**
 * Guarda el turno desde `validFrom` (sustituye la versión de ese mismo día si
 * ya existía). Devuelve el turno anterior que había en esa fecha, para el log.
 */
export async function setSchedule(pool, { userId, slots, validFrom, updatedBy }) {
  const from = readDate(validFrom, 'inicio del turno').text;
  const before = await getSchedule(pool, userId, from);
  await pool.query(
    `INSERT INTO work_schedules (user_id, valid_from, slots, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, valid_from) DO UPDATE SET slots = EXCLUDED.slots, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [userId, from, slots, updatedBy],
  );
  return { previous: before.current, validFrom: from, slots };
}

/** Todas las versiones de todos, para calcular quién estaba en cada turno. */
export async function allSchedules(db) {
  const result = await db.query(
    `SELECT user_id, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, slots
       FROM work_schedules ORDER BY user_id, valid_from`,
  );
  return result.rows.map((r) => ({ userId: r.user_id, validFrom: r.valid_from, slots: r.slots ?? [] }));
}
