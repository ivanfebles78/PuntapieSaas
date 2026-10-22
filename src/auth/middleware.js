import { findSessionUser, parseCookies } from './session.js';

export function toPublicUser(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function attachUser(pool, cookieName) {
  return async (req, _res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      req.sessionToken = cookies[cookieName] || null;
      const row = await findSessionUser(pool, req.sessionToken);
      req.user = row ? toPublicUser(row) : null;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, error: 'Necesitas iniciar sesión.' });
  }
  return next();
}
