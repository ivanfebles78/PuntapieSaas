import { createApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { applySchema, seedAdmin } from '../src/db/migrate.js';
import { seedTeam } from '../src/db/seed-team.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const ADMIN_EMAIL = 'admin@puntapie.test';
export const ADMIN_PASSWORD = 'AdminSecreta1';

export const testConfig = Object.freeze({
  port: 0,
  databaseUrl: TEST_DATABASE_URL,
  isProduction: false,
  appUrl: 'http://puntapie.test',
  adminEmail: ADMIN_EMAIL,
  adminName: 'Iván',
  adminInitialPassword: ADMIN_PASSWORD,
  resendApiKey: '',
  mailFrom: 'test@puntapie.test',
  sessionTtlMs: 60 * 60 * 1000,
  resetTokenTtlMs: 60 * 60 * 1000,
  inviteTokenTtlMs: 7 * 24 * 60 * 60 * 1000,
  cookieName: 'puntapie_session',
  loginMaxFailedAttempts: 1000,
  forgotMaxRequests: 1000,
  proveedores: { cifsPropios: ['B76766294'], ai: { apiKey: '', model: '', mode: 'off' } },
});

const silentLog = { info() {}, warn() {}, error() {} };

/**
 * Levanta la app sobre una base de datos limpia. El mailer guarda los
 * correos en memoria para poder leer el enlace de restablecimiento.
 */
export async function startTestServer() {
  const pool = createPool(TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS daily_sales, sales_days, supplier_uploads, supplier_payments, supplier_dues, supplier_docs, suppliers, supplier_files, audit_log, free_shifts, special_opening_staff, special_openings, work_schedules, settings, sales, expense_files, recurring_entries, recurring_amounts, recurring_expenses, vacations, password_resets, sessions, users CASCADE');
  await applySchema(pool);
  await seedAdmin(pool, testConfig, silentLog);
  await seedTeam(pool, undefined, silentLog);

  const sentMail = [];
  const mailer = {
    async sendPasswordReset(message) {
      sentMail.push({ kind: 'reset', ...message });
    },
    async sendInvitation(message) {
      sentMail.push({ kind: 'invite', ...message });
    },
  };

  const app = createApp({ pool, config: testConfig, log: silentLog, mailer });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    async function call(method, path, body) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const json = await response.json();
      return { status: response.status, ...json };
    }
    // Petición en crudo con la misma sesión (subidas y descargas de archivos).
    call.raw = (method, path, { body, headers = {} } = {}) => fetch(baseUrl + path, {
      method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body,
    });
    return call;
  }

  // El correo se envía tras responder: espera a que llegue.
  async function waitForMail(count) {
    for (let i = 0; i < 50 && sentMail.length < count; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return sentMail[count - 1];
  }

  async function loginAs(email, password) {
    const call = client();
    const result = await call('POST', '/api/auth/login', { email, password });
    if (result.status !== 200) throw new Error(`Login falló para ${email}: ${result.error}`);
    return call;
  }

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  return { pool, client, loginAs, sentMail, waitForMail, stop };
}

export function tokenFromLink(link) {
  return new URL(link).searchParams.get('token');
}
