import { findSessionUser, parseCookies } from './session.js';

export function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
}

// Mientras no cambie la contraseña inicial, solo puede cambiarla o salir.
export function requirePasswordChanged(req, res, next) {
  if (req.user?.mustChangePassword) {
    return res.status(403).json({
      ok: false,
      error: 'Debes cambiar tu contraseña antes de continuar.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  return next();
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

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Necesitas iniciar sesión.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'No tienes permiso para esta sección.' });
    }
    return next();
  };
}
