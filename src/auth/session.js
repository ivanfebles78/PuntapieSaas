import { generateToken, hashToken } from './tokens.js';

export async function createSession(pool, userId, ttlMs) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export async function findSessionUser(pool, token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

// Acepta un pool o un cliente dentro de una transacción.
export async function deleteUserSessions(db, userId) {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        try {
          return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
        } catch {
          return [part.slice(0, index), ''];
        }
      }),
  );
}
