import 'dotenv/config';

const DEFAULT_PORT = 3000;
const SESSION_DAYS = 30;
const RESET_TOKEN_MINUTES = 60;
const LOGIN_MAX_FAILED_ATTEMPTS = 20;
const FORGOT_MAX_REQUESTS = 10;

// Cuenta de Administrador inicial. Solo se usa al crearla por primera vez;
// ADMIN_EMAIL y ADMIN_PASSWORD_HASH las sustituyen. Hash bcrypt de 12 rondas.
const DEFAULT_ADMIN_EMAIL = 'ivan.febles@gmail.com';
export const DEFAULT_ADMIN_PASSWORD_HASH =
  '$2b$12$7YfbPCmtOuPHX72qxGhy/.bk75FG1irpNuR3HJD3EOiJghGMDUQDa';

function readEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

// Nunca se deriva del Host de la petición: evita enlaces de reseteo envenenados.
function resolveAppUrl(port) {
  const explicit = readEnv('APP_URL', '');
  if (explicit) return explicit.replace(/\/+$/, '');
  const railwayDomain = readEnv('RAILWAY_PUBLIC_DOMAIN', '');
  if (railwayDomain) return `https://${railwayDomain}`;
  return `http://localhost:${port}`;
}

const port = Number(readEnv('PORT', DEFAULT_PORT));

export const config = Object.freeze({
  port,
  databaseUrl: readEnv('DATABASE_URL', ''),
  isProduction: process.env.NODE_ENV === 'production',
  appUrl: resolveAppUrl(port),
  adminEmail: readEnv('ADMIN_EMAIL', DEFAULT_ADMIN_EMAIL).trim().toLowerCase(),
  adminName: readEnv('ADMIN_NAME', 'Iván'),
  adminInitialPassword: readEnv('ADMIN_INITIAL_PASSWORD', ''),
  adminPasswordHash: readEnv('ADMIN_PASSWORD_HASH', DEFAULT_ADMIN_PASSWORD_HASH),
  resendApiKey: readEnv('RESEND_API_KEY', ''),
  mailFrom: readEnv('MAIL_FROM', 'Puntapié <no-responder@zapateriapuntapie.com>'),
  sessionTtlMs: SESSION_DAYS * 24 * 60 * 60 * 1000,
  resetTokenTtlMs: RESET_TOKEN_MINUTES * 60 * 1000,
  cookieName: 'puntapie_session',
  loginMaxFailedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
  forgotMaxRequests: FORGOT_MAX_REQUESTS,
});

export function assertConfig(cfg = config) {
  if (!cfg.databaseUrl) {
    throw new Error('Falta la variable DATABASE_URL (conexión a PostgreSQL).');
  }
}
