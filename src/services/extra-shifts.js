import { weekday } from './stats.js';
import { TeamError } from './team.js';
import {
  BONUS_MINUTES_PER_SHIFT,
  SHIFT_IDS,
  SHIFT_MINUTES,
  isExtraSlot,
  isRegularSlot,
  slotKey,
} from './shop-hours.js';
import { getSchedule } from './schedules.js';
import { readDate } from './vacations.js';
import { todayInShop } from './vacation-balance.js';

// Aperturas extra (sábado tarde, domingo mañana) y horas bonificadas: cada
// turno extra trabajado suma 7 h (3,5 h × 2) y cada turno libre resta 3,5 h.

const MAX_NOTE_LENGTH = 200;
const MAX_STAFF = 20;

export function readNote(value) {
  const note = String(value ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new TeamError(400, `La nota no puede superar ${MAX_NOTE_LENGTH} caracteres.`, 'INVALID_NOTE');
  }
  return note;
}

function readShift(value) {
  if (!SHIFT_IDS.includes(value)) throw new TeamError(400, 'El turno debe ser «mañana» o «tarde».', 'INVALID_SHIFT');
  return value;
}

export function readStaff(value) {
  if (!Array.isArray(value)) throw new TeamError(400, 'Indica quién trabaja.', 'INVALID_STAFF');
  const ids = [...new Set(value.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || ids.length > MAX_STAFF) {
    throw new TeamError(400, 'La lista de personas no es válida.', 'INVALID_STAFF');
  }
  return ids.sort((a, b) => a - b);
}

/** Valida { day, shift, note, staff } de una apertura extra. */
export function readOpening(body) {
  const day = readDate(body?.day, 'la apertura').text;
  const shift = readShift(body?.shift);
  if (!isExtraSlot(weekday(day), shift)) {
    throw new TeamError(400, 'Solo se abre de forma puntual el sábado por la tarde o el domingo por la mañana.', 'NOT_EXTRA_SLOT');
  }
  return { day, shift, note: readNote(body?.note), staff: readStaff(body?.staff ?? []) };
}

export function readFreeShift(body) {
  return { day: readDate(body?.day, 'el turno libre').text, shift: readShift(body?.shift), note: readNote(body?.note) };
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

/* ---------- Aperturas extra ---------- */

async function assertActiveStaff(db, ids) {
  if (!ids.length) return [];
  const result = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[]) AND is_active', [ids]);
  if (result.rowCount !== ids.length) {
    throw new TeamError(400, 'Alguna de las personas no existe o está de baja.', 'INVALID_STAFF');
  }
  return result.rows;
}

const OPENING_COLUMNS = `
  o.id, to_char(o.day, 'YYYY-MM-DD') AS day, o.shift, o.note,
  COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY lower(u.name))
    FILTER (WHERE u.id IS NOT NULL), '[]') AS staff`;

function toOpening(row, today) {
  return {
    id: row.id,
    day: row.day,
    shift: row.shift,
    note: row.note,
    staff: row.staff,
    // Las horas se ganan cuando el día ya ha pasado.
    done: row.day < today,
    bonusMinutes: BONUS_MINUTES_PER_SHIFT,
  };
}

async function findOpening(db, id) {
  const result = await db.query(
    `SELECT ${OPENING_COLUMNS} FROM special_openings o
       LEFT JOIN special_opening_staff s ON s.opening_id = o.id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE o.id = $1 GROUP BY o.id`,
    [id],
  );
  if (result.rowCount === 0) throw new TeamError(404, 'Esa apertura no existe.', 'OPENING_NOT_FOUND');
  return result.rows[0];
}

export async function listOpenings(pool, today = todayInShop()) {
  const result = await pool.query(
    `SELECT ${OPENING_COLUMNS} FROM special_openings o
       LEFT JOIN special_opening_staff s ON s.opening_id = o.id
       LEFT JOIN users u ON u.id = s.user_id
      GROUP BY o.id ORDER BY o.day DESC, o.shift`,
  );
  return result.rows.map((row) => toOpening(row, today));
}

async function replaceStaff(db, openingId, staff) {
  await db.query('DELETE FROM special_opening_staff WHERE opening_id = $1', [openingId]);
  if (staff.length) {
    await db.query(
      'INSERT INTO special_opening_staff (opening_id, user_id) SELECT $1, unnest($2::int[])',
      [openingId, staff],
    );
  }
}

export async function createOpening(pool, { day, shift, note, staff, createdBy, today = todayInShop() }) {
  return withTransaction(pool, async (client) => {
    await assertActiveStaff(client, staff);
    const inserted = await client.query(
      `INSERT INTO special_openings (day, shift, note, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (day, shift) DO NOTHING RETURNING id`,
      [day, shift, note, createdBy],
    );
    if (inserted.rowCount === 0) throw new TeamError(409, 'Ese turno ya está abierto.', 'OPENING_EXISTS');
    await replaceStaff(client, inserted.rows[0].id, staff);
    return toOpening(await findOpening(client, inserted.rows[0].id), today);
  });
}

/**
 * Quitar a alguien de una apertura ya trabajada le resta 7 h: no se permite
 * si ya las ha gastado en turnos libres (el saldo quedaría en negativo).
 */
async function assertCanLoseBonus(db, opening, userIds, today) {
  if (!opening.done || userIds.length === 0) return;
  await db.query('SELECT 1 FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [userIds]);
  for (const userId of userIds) {
    const balance = await getBonusOverview(db, userId, today);
    if (balance.balanceMinutes - BONUS_MINUTES_PER_SHIFT < 0) {
      const name = opening.staff.find((p) => p.id === userId)?.name ?? 'Esa persona';
      throw new TeamError(409, `${name} ya ha gastado esas horas en turnos libres. Borra antes alguno de sus turnos libres.`, 'BONUS_ALREADY_USED');
    }
  }
}

/** Cambia nota y equipo. Devuelve { before, after } para el log. */
export async function updateOpening(pool, id, { note, staff }, today = todayInShop()) {
  return withTransaction(pool, async (client) => {
    const before = toOpening(await findOpening(client, id), today);
    const current = staff ?? before.staff.map((p) => p.id);
    await assertCanLoseBonus(client, before, before.staff.map((p) => p.id).filter((uid) => !current.includes(uid)), today);
    // Quien ya no está activo puede seguir en una apertura pasada, pero no se puede añadir.
    const added = current.filter((uid) => !before.staff.some((p) => p.id === uid));
    await assertActiveStaff(client, added);
    await client.query('UPDATE special_openings SET note = $2 WHERE id = $1', [id, note ?? before.note]);
    await replaceStaff(client, id, current);
    return { before, after: toOpening(await findOpening(client, id), today) };
  });
}

export async function deleteOpening(pool, id, today = todayInShop()) {
  return withTransaction(pool, async (client) => {
    const before = toOpening(await findOpening(client, id), today);
    await assertCanLoseBonus(client, before, before.staff.map((p) => p.id), today);
    await client.query('DELETE FROM special_openings WHERE id = $1', [id]);
    return before;
  });
}

/* ---------- Horas bonificadas ---------- */

/**
 * Saldo de horas (en minutos): ganadas con aperturas ya trabajadas, las que
 * se ganarán con las programadas y las gastadas en turnos libres (pasados y
 * futuros). El saldo disponible solo cuenta lo ya ganado.
 */
export async function getBonusOverview(pool, userId, today = todayInShop()) {
  const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (user.rowCount === 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
  const openings = await pool.query(
    `SELECT o.id, to_char(o.day, 'YYYY-MM-DD') AS day, o.shift, o.note
       FROM special_openings o JOIN special_opening_staff s ON s.opening_id = o.id
      WHERE s.user_id = $1 ORDER BY o.day DESC`,
    [userId],
  );
  const free = await pool.query(
    `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, shift, note
       FROM free_shifts WHERE user_id = $1 ORDER BY day DESC, shift`,
    [userId],
  );
  const worked = openings.rows.filter((o) => o.day < today);
  const earnedMinutes = worked.length * BONUS_MINUTES_PER_SHIFT;
  const pendingMinutes = (openings.rowCount - worked.length) * BONUS_MINUTES_PER_SHIFT;
  const usedMinutes = free.rowCount * SHIFT_MINUTES;
  const balanceMinutes = earnedMinutes - usedMinutes;
  return {
    shiftMinutes: SHIFT_MINUTES,
    earnedMinutes,
    pendingMinutes,
    usedMinutes,
    balanceMinutes,
    freeShiftsAvailable: Math.max(0, Math.floor(balanceMinutes / SHIFT_MINUTES)),
    openings: openings.rows.map((o) => ({ ...o, done: o.day < today, bonusMinutes: BONUS_MINUTES_PER_SHIFT })),
    freeShifts: free.rows.map((f) => ({ ...f, done: f.day < today })),
  };
}

/**
 * Pide un turno libre con horas bonificadas. Tiene que ser un turno que la
 * persona trabaja ese día, fuera de sus vacaciones, y debe quedarle saldo.
 */
export async function addFreeShift(pool, { userId, day, shift, note, createdBy, today = todayInShop() }) {
  return withTransaction(pool, async (client) => {
    const locked = await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (locked.rowCount === 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
    if (!isRegularSlot(weekday(day), shift)) {
      throw new TeamError(400, 'Ese día y turno la tienda no abre de forma normal.', 'NOT_REGULAR_SLOT');
    }
    const { current } = await getSchedule(client, userId, day);
    if (!current?.slots.includes(slotKey(weekday(day), shift))) {
      throw new TeamError(409, 'Según su turno, ese día no trabaja en ese horario.', 'NOT_IN_SCHEDULE');
    }
    const vacation = await client.query(
      'SELECT 1 FROM vacations WHERE user_id = $1 AND $2::date BETWEEN start_date AND end_date',
      [userId, day],
    );
    if (vacation.rowCount > 0) throw new TeamError(409, 'Ese día ya está de vacaciones.', 'ON_VACATION');
    const balance = await getBonusOverview(client, userId, today);
    if (balance.balanceMinutes < SHIFT_MINUTES) {
      throw new TeamError(409, 'No le quedan horas bonificadas suficientes (hace falta 3,5 h por turno).', 'NO_BONUS_LEFT');
    }
    const inserted = await client.query(
      `INSERT INTO free_shifts (user_id, day, shift, note, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, day, shift) DO NOTHING
       RETURNING id, to_char(day, 'YYYY-MM-DD') AS day, shift, note`,
      [userId, day, shift, note, createdBy],
    );
    if (inserted.rowCount === 0) throw new TeamError(409, 'Ese turno libre ya está apuntado.', 'FREE_SHIFT_EXISTS');
    return inserted.rows[0];
  });
}

export async function deleteFreeShift(pool, userId, freeShiftId) {
  const removed = await pool.query(
    `DELETE FROM free_shifts WHERE id = $1 AND user_id = $2
     RETURNING to_char(day, 'YYYY-MM-DD') AS day, shift`,
    [freeShiftId, userId],
  );
  if (removed.rowCount === 0) throw new TeamError(404, 'Ese turno libre no existe.', 'FREE_SHIFT_NOT_FOUND');
  return removed.rows[0];
}
