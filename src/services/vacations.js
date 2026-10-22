import { TeamError } from './team.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const MAX_NOTE_LENGTH = 200;
const DAY_MS = 86400000;

// Fechas como texto «YYYY-MM-DD»: así no las desplaza la zona horaria.
const VACATION_COLUMNS = `
  id, user_id, note, created_at,
  to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date, 'YYYY-MM-DD') AS end_date,
  (end_date - start_date + 1) AS days`;

function toVacation(row) {
  return {
    id: row.id,
    userId: row.user_id,
    start: row.start_date,
    end: row.end_date,
    days: row.days,
    note: row.note,
    createdAt: row.created_at,
  };
}

function readDate(value, label) {
  const text = String(value ?? '');
  const date = new Date(`${text}T00:00:00Z`);
  if (!DATE_PATTERN.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TeamError(400, `La fecha de ${label} no es válida.`, 'INVALID_DATE');
  }
  return { text, time: date.getTime() };
}

/** Valida y normaliza un periodo { start, end, note }. */
export function readVacation(body) {
  const start = readDate(body?.start, 'inicio');
  const end = readDate(body?.end, 'fin');
  if (end.time < start.time) {
    throw new TeamError(400, 'La fecha de fin no puede ser anterior a la de inicio.', 'INVALID_RANGE');
  }
  if ((end.time - start.time) / DAY_MS + 1 > MAX_DAYS) {
    throw new TeamError(400, `Un periodo no puede superar ${MAX_DAYS} días.`, 'INVALID_RANGE');
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new TeamError(400, `La nota no puede superar ${MAX_NOTE_LENGTH} caracteres.`, 'INVALID_NOTE');
  }
  return { start: start.text, end: end.text, note };
}

async function assertUserExists(db, userId) {
  const result = await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (result.rowCount === 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
}

export async function listVacations(pool, userId) {
  await assertUserExists(pool, userId);
  const result = await pool.query(
    `SELECT ${VACATION_COLUMNS} FROM vacations WHERE user_id = $1 ORDER BY start_date DESC`,
    [userId],
  );
  return result.rows.map(toVacation);
}

/**
 * Añade un periodo. Bloquea la fila del usuario para que dos altas
 * simultáneas no puedan solaparse.
 */
export async function addVacation(pool, { userId, start, end, note, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertUserExists(client, userId);
    const overlap = await client.query(
      `SELECT to_char(start_date, 'DD/MM/YYYY') AS s, to_char(end_date, 'DD/MM/YYYY') AS e
         FROM vacations WHERE user_id = $1 AND start_date <= $3 AND end_date >= $2 LIMIT 1`,
      [userId, start, end],
    );
    if (overlap.rowCount > 0) {
      const { s, e } = overlap.rows[0];
      throw new TeamError(409, `Se solapa con otras vacaciones (del ${s} al ${e}).`, 'VACATION_OVERLAP');
    }
    const inserted = await client.query(
      `INSERT INTO vacations (user_id, start_date, end_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${VACATION_COLUMNS}`,
      [userId, start, end, note, createdBy],
    );
    await client.query('COMMIT');
    return toVacation(inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteVacation(pool, userId, vacationId) {
  const result = await pool.query('DELETE FROM vacations WHERE id = $1 AND user_id = $2', [vacationId, userId]);
  if (result.rowCount === 0) throw new TeamError(404, 'Ese periodo de vacaciones no existe.', 'VACATION_NOT_FOUND');
}
