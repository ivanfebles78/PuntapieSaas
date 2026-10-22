import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateNewPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/session.js';
import { toPublicUser } from '../auth/middleware.js';
import {
  authenticate,
  createPasswordReset,
  findActiveUserByEmail,
  isResetTokenValid,
  normalizeEmail,
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
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? '');
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Indica tu correo y tu contraseña.' });
      }
      const user = await authenticate(pool, email, password);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
      }
      const { token, expiresAt } = await createSession(pool, user.id, cfg.sessionTtlMs);
      res.cookie(cfg.cookieName, token, cookieOptions(cfg, expiresAt));
      return res.json({ ok: true, data: toPublicUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await deleteSession(pool, req.sessionToken);
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
      const valid = await isResetTokenValid(pool, readToken(req.body));
      return res.json({ ok: true, data: { valid } });
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
