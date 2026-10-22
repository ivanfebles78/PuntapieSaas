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

export async function findActiveUserByEmail(pool, email) {
  const result = await pool.query(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = $1 AND is_active',
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}

export async function authenticate(pool, email, password) {
  const user = await findActiveUserByEmail(pool, email);
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
  return user && ok ? user : null;
}

/**
 * Genera un token de un solo uso y anula los anteriores del mismo usuario.
 * Devuelve el token en claro, que solo viaja en el correo.
 */
export async function createPasswordReset(pool, userId, ttlMs) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  await pool.query(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, expiresAt],
  );
  return token;
}

export async function isResetTokenValid(pool, token) {
  if (!token) return false;
  const result = await pool.query(
    `SELECT 1
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW() AND u.is_active`,
    [hashToken(token)],
  );
  return result.rowCount > 0;
}

/**
 * Cambia la contraseña consumiendo el token de forma atómica y cierra
 * todas las sesiones abiertas de esa cuenta. Devuelve false si el token
 * ya no es válido.
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
      'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2 AND is_active',
      [passwordHash, consumed.rows[0].user_id],
    );
    if (!updated || updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await deleteUserSessions(client, consumed.rows[0].user_id);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
