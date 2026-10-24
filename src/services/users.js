import { hashPassword, verifyPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/session.js';
import { generateToken, hashToken } from '../auth/tokens.js';

// Se compara contra un hash cualquiera cuando el email no existe para que
// el tiempo de respuesta no revele qué cuentas hay.
let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ??= hashPassword(generateToken());
  return dummyHashPromise;
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

const LOGIN_COLUMNS = 'id, email, username, name, role, password_hash, must_change_password';

export async function findActiveUserByEmail(pool, email) {
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS} FROM users WHERE email = $1 AND is_active`,
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}

/** Busca por correo si lleva «@»; si no, por nombre de usuario (sin distinguir mayúsculas). */
export async function findActiveUserByLogin(pool, identifier) {
  const value = normalizeEmail(identifier);
  if (value.includes('@')) return findActiveUserByEmail(pool, value);
  const result = await pool.query(
    `SELECT ${LOGIN_COLUMNS} FROM users WHERE lower(username) = $1 AND is_active`,
    [value],
  );
  return result.rows[0] ?? null;
}

// Las cuentas invitadas aún no tienen contraseña: nunca pueden entrar con una.
export async function authenticate(pool, identifier, password) {
  const user = await findActiveUserByLogin(pool, identifier);
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
  return user?.password_hash && ok ? user : null;
}

/**
 * Cambio de contraseña con sesión iniciada (el obligatorio del primer acceso
 * o uno voluntario). Mantiene la sesión actual y cierra las demás.
 */
export async function changeOwnPassword(pool, userId, newPassword, keepSessionToken) {
  const passwordHash = await hashPassword(newPassword);
  await pool.query(
    `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE
      WHERE id = $2`,
    [passwordHash, userId],
  );
  await pool.query(
    'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
    [userId, hashToken(keepSessionToken ?? '')],
  );
}

export async function findPasswordHash(pool, userId) {
  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.password_hash ?? null;
}

export async function recordLogin(pool, userId) {
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}

/**
 * Genera un token de un solo uso y anula los anteriores del mismo usuario.
 * `purpose` distingue restablecer ('reset') de aceptar una invitación ('invite').
 * Devuelve el token en claro, que solo viaja en el correo.
 */
export async function createPasswordReset(pool, userId, ttlMs, purpose = 'reset') {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  await pool.query(
    'INSERT INTO password_resets (token_hash, user_id, expires_at, purpose) VALUES ($1, $2, $3, $4)',
    [hashToken(token), userId, expiresAt, purpose],
  );
  return token;
}

/** Devuelve 'reset' o 'invite' si el token sigue vigente, o null. */
export async function getResetTokenPurpose(pool, token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT r.purpose
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW() AND u.is_active`,
    [hashToken(token)],
  );
  return result.rows[0]?.purpose ?? null;
}

export async function invalidateUserTokens(db, userId) {
  await db.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId]);
}

/**
 * Cambia la contraseña consumiendo el token de forma atómica y cierra
 * todas las sesiones abiertas de esa cuenta. Devuelve { id, name } de la
 * cuenta, o false si el token ya no es válido.
 */
export async function resetPasswordWithToken(pool, token, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query(
      `UPDATE password_resets SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING user_id`,
      [hashToken(token)],
    );
    const updated = consumed.rowCount === 0 ? null : await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE
        WHERE id = $2 AND is_active RETURNING id, name`,
      [passwordHash, consumed.rows[0].user_id],
    );
    if (!updated || updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await deleteUserSessions(client, consumed.rows[0].user_id);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
