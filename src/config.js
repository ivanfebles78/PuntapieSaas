import 'dotenv/config';

const DEFAULT_PORT = 3000;
const SESSION_DAYS = 30;
const RESET_TOKEN_MINUTES = 60;
const INVITE_TOKEN_DAYS = 7;
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
  inviteTokenTtlMs: INVITE_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  cookieName: 'puntapie_session',
  loginMaxFailedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
  forgotMaxRequests: FORGOT_MAX_REQUESTS,
  // Día en que la tienda pasó a ser nuestra: las estadísticas no cuentan ventas
  // ni gastos anteriores (eran del dueño anterior).
  businessStart: readEnv('BUSINESS_START', '2026-04-16'),
  // Datos de la tienda que salen en el ticket (factura simplificada).
  tienda: Object.freeze({
    nombre: readEnv('TIENDA_NOMBRE', 'Puntapié'),
    razonSocial: readEnv('TIENDA_RAZON_SOCIAL', 'Calzando Sueños, S.L.'),
    cif: readEnv('TIENDA_CIF', 'B76766294'),
    direccion: readEnv('TIENDA_DIRECCION', 'Calle Viera y Clavijo, 1 · 38003 Santa Cruz de Tenerife'),
    telefono: readEnv('TIENDA_TELEFONO', '922 124 962'),
    igic: Number(readEnv('TIENDA_IGIC', '7')),
  }),
  // Aprobaciones a distancia (descuentos de más del 15 % y cierres de caja que no
  // cuadran): WhatsApp Cloud API de Meta, plantilla con 2 variables ({{1}} qué se
  // pide, {{2}} enlace). Sin token, el TPV abre WhatsApp con el mensaje escrito.
  whatsapp: Object.freeze({
    token: readEnv('WHATSAPP_TOKEN', ''),
    phoneId: readEnv('WHATSAPP_PHONE_ID', ''),
    plantilla: readEnv('WHATSAPP_PLANTILLA', 'aprobacion_tpv'),
    idioma: readEnv('WHATSAPP_IDIOMA', 'es'),
    // Móviles de quien aprueba, con prefijo y sin «+» (34600111222), separados por comas.
    aprobadores: readEnv('WHATSAPP_APROBADORES', '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  }),
  // Revisión diaria del correo (facturas y pedidos): Gmail con contraseña de aplicación.
  correo: Object.freeze({
    user: readEnv('GMAIL_USER', '').trim(),
    pass: readEnv('GMAIL_APP_PASSWORD', '').replace(/\s+/g, ''),
    hora: Number(readEnv('CORREO_HORA', '8')),
  }),
  proveedores: Object.freeze({
    // CIF/NIF propios (Calzando Sueños): se ignoran al buscar el proveedor en un PDF.
    cifsPropios: readEnv('CIFS_PROPIOS', 'B76766294').split(',').map((s) => s.trim()).filter(Boolean),
    // Lector con IA para proveedores sin lector propio: solo con ANTHROPIC_API_KEY.
    // AI_MODE: 'auto' (solo si el lector es el genérico), 'always' u 'off'.
    ai: Object.freeze({
      apiKey: readEnv('ANTHROPIC_API_KEY', ''),
      model: readEnv('AI_MODEL', 'claude-sonnet-5-5'),
      mode: readEnv('AI_MODE', 'auto'),
    }),
  }),
});

export function assertConfig(cfg = config) {
  if (!cfg.databaseUrl) {
    throw new Error('Falta la variable DATABASE_URL (conexión a PostgreSQL).');
  }
}
