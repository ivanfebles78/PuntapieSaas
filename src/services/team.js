import { deleteUserSessions } from '../auth/session.js';
import { invalidateUserTokens, normalizeEmail } from './users.js';

/** Error de negocio con su código HTTP, para que la ruta lo traduzca tal cual. */
export class TeamError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const USER_COLUMNS = `
  u.id, u.email, u.username, u.name, u.role, u.is_active, u.created_at, u.invited_at,
  u.last_login_at, u.deactivated_at, u.must_change_password, u.is_seller,
  (u.password_hash IS NOT NULL) AS has_password, inviter.name AS invited_by_name,
  (SELECT to_char(v.end_date, 'YYYY-MM-DD') FROM vacations v
    WHERE v.user_id = u.id AND CURRENT_DATE BETWEEN v.start_date AND v.end_date
    ORDER BY v.end_date DESC LIMIT 1) AS on_vacation_until,
  (SELECT to_char(min(v.start_date), 'YYYY-MM-DD') FROM vacations v
    WHERE v.user_id = u.id AND v.start_date > CURRENT_DATE) AS next_vacation,
  (SELECT ws.slots FROM work_schedules ws
    WHERE ws.user_id = u.id AND ws.valid_from <= CURRENT_DATE
    ORDER BY ws.valid_from DESC LIMIT 1) AS slots`;

export function userStatus(row) {
  if (!row.is_active) return 'baja';
  return row.has_password ? 'activo' : 'invitado';
}

export function toTeamMember(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    role: row.role,
    status: userStatus(row),
    mustChangePassword: row.must_change_password,
    // false = administra pero no vende: no entra en ventas por empleado ni turnos.
    isSeller: row.is_seller !== false,
    createdAt: row.created_at,
    invitedAt: row.invited_at,
    invitedBy: row.invited_by_name ?? null,
    lastLoginAt: row.last_login_at,
    deactivatedAt: row.deactivated_at,
    onVacationUntil: row.on_vacation_until ?? null,
    nextVacation: row.next_vacation ?? null,
    // Turno fijo vigente (null = aún sin turno asignado).
    slots: row.slots ?? null,
  };
}

async function findMember(db, id) {
  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN users inviter ON inviter.id = u.invited_by WHERE u.id = $1`,
    [id],
  );
  if (result.rowCount === 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
  return result.rows[0];
}

export async function listMembers(pool) {
  const result = await pool.query(
    `SELECT ${USER_COLUMNS}
       FROM users u
       LEFT JOIN users inviter ON inviter.id = u.invited_by
      ORDER BY u.is_active DESC, lower(u.name), u.id`,
  );
  return result.rows.map(toTeamMember);
}

export async function getMember(pool, id) {
  return toTeamMember(await findMember(pool, id));
}

export async function createInvitedMember(pool, { email, name, role, invitedBy }) {
  const result = await pool.query(
    `INSERT INTO users (email, name, role, password_hash, invited_at, invited_by)
     VALUES ($1, $2, $3, NULL, NOW(), $4)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [normalizeEmail(email), name, role, invitedBy],
  );
  if (result.rowCount === 0) {
    throw new TeamError(409, 'Ya existe una cuenta con ese correo.', 'EMAIL_TAKEN');
  }
  return getMember(pool, result.rows[0].id);
}

/**
 * Ejecuta `work` en una transacción con los administradores activos
 * bloqueados, para que dos cambios simultáneos no dejen la tienda sin
 * ningún Administrador.
 */
async function withAdminLock(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admins = await client.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active ORDER BY id FOR UPDATE",
    );
    const value = await work(client, admins.rows.map((row) => row.id));
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function assertNotLastAdmin(adminIds, userId) {
  if (adminIds.length === 1 && adminIds[0] === userId) {
    throw new TeamError(409, 'Debe quedar al menos un Administrador activo.', 'LAST_ADMIN');
  }
}

export async function updateMember(pool, actorId, id, { name, role, email, isSeller }) {
  return withAdminLock(pool, async (client, adminIds) => {
    const current = await findMember(client, id);
    if (role !== undefined && role !== current.role) {
      if (id === actorId) {
        throw new TeamError(409, 'No puedes cambiar tu propio rol.', 'SELF_ROLE');
      }
      if (current.role === 'admin' && current.is_active) assertNotLastAdmin(adminIds, id);
    }
    if (email !== undefined && email !== current.email) {
      const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [email, id]);
      if (taken.rowCount > 0) throw new TeamError(409, 'Ya existe una cuenta con ese correo.', 'EMAIL_TAKEN');
    }
    await client.query(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), email = COALESCE($4, email),
              is_seller = COALESCE($5, is_seller)
        WHERE id = $1`,
      [id, name ?? null, role ?? null, email ?? null, isSeller ?? null],
    );
    return toTeamMember(await findMember(client, id));
  });
}

/**
 * Pone una contraseña provisional (para cuentas sin correo) y obliga a
 * cambiarla al entrar. Cierra sus sesiones y anula enlaces pendientes.
 */
export async function setTemporaryPassword(pool, id, passwordHash) {
  const current = await findMember(pool, id);
  if (!current.is_active) {
    throw new TeamError(409, 'Reactiva la cuenta antes de cambiar su contraseña.', 'USER_INACTIVE');
  }
  await pool.query(
    `UPDATE users SET password_hash = $2, must_change_password = TRUE, password_changed_at = NOW()
      WHERE id = $1`,
    [id, passwordHash],
  );
  await deleteUserSessions(pool, id);
  await invalidateUserTokens(pool, id);
  return getMember(pool, id);
}

export async function deactivateMember(pool, actorId, id) {
  return withAdminLock(pool, async (client, adminIds) => {
    const current = await findMember(client, id);
    if (id === actorId) {
      throw new TeamError(409, 'No puedes darte de baja a ti mismo.', 'SELF_DEACTIVATE');
    }
    if (!current.is_active) return toTeamMember(current);
    if (current.role === 'admin') assertNotLastAdmin(adminIds, id);
    await client.query('UPDATE users SET is_active = FALSE, deactivated_at = NOW() WHERE id = $1', [id]);
    await deleteUserSessions(client, id);
    await invalidateUserTokens(client, id);
    return toTeamMember(await findMember(client, id));
  });
}

export async function reactivateMember(pool, id) {
  await findMember(pool, id);
  await pool.query('UPDATE users SET is_active = TRUE, deactivated_at = NULL WHERE id = $1', [id]);
  return getMember(pool, id);
}
