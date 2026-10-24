import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateNewPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/session.js';
import { requireAuth, toPublicUser } from '../auth/middleware.js';
import { auditFrom } from '../services/audit.js';
import {
  authenticate,
  changeOwnPassword,
  createPasswordReset,
  findPasswordHash,
  findActiveUserByEmail,
  getResetTokenPurpose,
  normalizeEmail,
  recordLogin,
  resetPasswordWithToken,
} from '../services/users.js';

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;
const MAX_TOKEN_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORGOT_MESSAGE =
  'Si el correo pertenece a una cuenta, recibirás un enlace para restablecer la contraseña.';

function cookieOptions(cfg, expires) {
  return { httpOnly: true, sameSite: 'lax', secure: cfg.isProduction, path: '/', expires };
}

function limiter(limit, message, extra = {}) {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: message },
    ...extra,
  });
}

function readToken(body) {
  const token = String(body?.token ?? '');
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : '';
}

export function authRouter({ pool, config: cfg, mailer, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const MAX_LOGGED_IDENTIFIER = 100;

  // Solo cuentan los fallos: en la tienda varias personas comparten IP.
  const loginLimiter = limiter(
    cfg.loginMaxFailedAttempts,
    'Demasiados intentos fallidos. Espera unos minutos.',
    { skipSuccessfulRequests: true },
  );
  const forgotLimiter = limiter(cfg.forgotMaxRequests, 'Demasiadas solicitudes. Inténtalo más tarde.');
  const resetLimiter = limiter(cfg.loginMaxFailedAttempts, 'Demasiados intentos. Inténtalo más tarde.');

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      // Se entra con correo o con nombre de usuario.
      const identifier = normalizeEmail(req.body?.identifier ?? req.body?.email);
      const password = String(req.body?.password ?? '');
      if (!identifier || !password) {
        return res.status(400).json({ ok: false, error: 'Indica tu usuario o correo y tu contraseña.' });
      }
      const user = await authenticate(pool, identifier, password);
      if (!user) {
        await audit(req, { actor: null, area: 'sesion', action: 'entrar_fallido', target: identifier.slice(0, MAX_LOGGED_IDENTIFIER) });
        return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
      }
      const { token, expiresAt } = await createSession(pool, user.id, cfg.sessionTtlMs);
      await recordLogin(pool, user.id);
      await audit(req, { actor: user, area: 'sesion', action: 'entrar', target: user.name });
      res.cookie(cfg.cookieName, token, cookieOptions(cfg, expiresAt));
      return res.json({ ok: true, data: toPublicUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await deleteSession(pool, req.sessionToken);
      if (req.user) await audit(req, { area: 'sesion', action: 'salir', target: req.user.name });
      res.clearCookie(cfg.cookieName, { path: '/' });
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Sin sesión.' });
    return res.json({ ok: true, data: req.user });
  });

  // En el primer acceso la contraseña inicial ya se comprobó al entrar; en un
  // cambio voluntario se exige la actual.
  router.post('/change-password', requireAuth, resetLimiter, async (req, res, next) => {
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
      const validationError = validateNewPassword(newPassword, confirmPassword);
      if (validationError) return res.status(400).json({ ok: false, error: validationError });

      const hash = await findPasswordHash(pool, req.user.id);
      if (!req.user.mustChangePassword && !(await verifyPassword(String(currentPassword ?? ''), hash ?? ''))) {
        return res.status(400).json({ ok: false, error: 'La contraseña actual no es correcta.' });
      }
      if (hash && (await verifyPassword(newPassword, hash))) {
        return res.status(400).json({ ok: false, error: 'La nueva contraseña debe ser distinta de la actual.' });
      }
      await changeOwnPassword(pool, req.user.id, newPassword, req.sessionToken);
      await audit(req, { area: 'sesion', action: 'cambiar_contrasena', target: req.user.name });
      return res.json({ ok: true, data: { ...req.user, mustChangePassword: false } });
    } catch (error) {
      return next(error);
    }
  });

  // Respuesta idéntica exista o no la cuenta, y el correo se envía en
  // segundo plano para no delatarla por el tiempo de respuesta.
  router.post('/forgot-password', forgotLimiter, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
        return res.status(400).json({ ok: false, error: 'Escribe un correo electrónico válido.' });
      }
      res.json({ ok: true, data: { message: FORGOT_MESSAGE } });

      const user = await findActiveUserByEmail(pool, email);
      if (!user) return undefined;
      await audit(req, { actor: user, area: 'sesion', action: 'pedir_enlace', target: user.name });
      const token = await createPasswordReset(pool, user.id, cfg.resetTokenTtlMs);
      const link = `${cfg.appUrl}/restablecer?token=${encodeURIComponent(token)}`;
      await mailer.sendPasswordReset({ to: user.email, name: user.name, link });
      return undefined;
    } catch (error) {
      if (res.headersSent) {
        log.error('[forgot-password] No se pudo enviar el enlace:', error.message);
        return undefined;
      }
      return next(error);
    }
  });

  router.post('/reset-password/check', resetLimiter, async (req, res, next) => {
    try {
      const purpose = await getResetTokenPurpose(pool, readToken(req.body));
      return res.json({ ok: true, data: { valid: Boolean(purpose), purpose } });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/reset-password', resetLimiter, async (req, res, next) => {
    try {
      const token = readToken(req.body);
      const { newPassword, confirmPassword } = req.body ?? {};
      if (!token) {
        return res.status(400).json({ ok: false, error: 'El enlace no es válido.' });
      }
      const validationError = validateNewPassword(newPassword, confirmPassword);
      if (validationError) {
        return res.status(400).json({ ok: false, error: validationError });
      }
      const changed = await resetPasswordWithToken(pool, token, newPassword);
      if (changed) await audit(req, { actor: changed, area: 'sesion', action: 'restablecer', target: changed.name });
      if (!changed) {
        return res.status(400).json({
          ok: false,
          error: 'El enlace ha caducado o ya se ha usado. Solicita uno nuevo.',
          code: 'RESET_TOKEN_INVALID',
        });
      }
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
