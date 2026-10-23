import express from 'express';
import { fileURLToPath } from 'node:url';
import { attachUser, requireAuth, requirePasswordChanged, requireRole } from './auth/middleware.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { estadisticasRouter } from './routes/estadisticas.js';
import { gastosRouter } from './routes/gastos.js';
import { createMailer } from './services/mail.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const JSON_LIMIT = '64kb';
const IMAGE_MAX_AGE = '30d';

export function createApp({ pool, config, log = console, mailer = createMailer(config, log) }) {
  const app = express();
  app.disable('x-powered-by');
  // Railway pone un proxy TLS delante: necesario para cookies "secure" y rate limit por IP.
  app.set('trust proxy', 1);

  app.use(express.json({ limit: JSON_LIMIT }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, data: { status: 'ok' } });
    } catch (error) {
      log.error('[health] Base de datos no disponible:', error.message);
      res.status(503).json({ ok: false, error: 'Base de datos no disponible.' });
    }
  });

  app.use('/api', attachUser(pool, config.cookieName));
  app.use('/api/auth', authRouter({ pool, config, mailer, log }));
  // A partir de aquí, todo exige haber cambiado la contraseña inicial.
  app.use('/api/admin', requireAuth, requirePasswordChanged, adminRouter({ pool, config, mailer, log }));
  // Gastos: de momento lo ven y editan Administrador y Empleado.
  app.use('/api/gastos', requireAuth, requirePasswordChanged, requireRole('admin', 'empleado'), gastosRouter({ pool }));
  app.use('/api/estadisticas', requireAuth, requirePasswordChanged, requireRole('admin', 'empleado'), estadisticasRouter({ pool }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, error: 'Ruta no encontrada.' });
  });

  app.use('/img', express.static(`${PUBLIC_DIR}/img`, { maxAge: IMAGE_MAX_AGE }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: true, maxAge: 0 }));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile('index.html', { root: PUBLIC_DIR });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'JSON no válido.' });
    }
    log.error('[error]', error);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  });

  return app;
}
