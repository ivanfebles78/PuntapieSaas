import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  TEST_DATABASE_URL,
  startTestServer,
  tokenFromLink,
} from './helpers.js';
import { validateNewPassword } from '../src/auth/password.js';

describe('validateNewPassword', () => {
  test('exige longitud mínima, letras y números, y que coincidan', () => {
    assert.match(validateNewPassword('corta1', 'corta1'), /al menos 8/);
    assert.match(validateNewPassword('soloLetras', 'soloLetras'), /letras y números/);
    assert.match(validateNewPassword('Valida123', 'Valida124'), /no coinciden/);
    assert.equal(validateNewPassword('Valida123', 'Valida123'), null);
  });
});

describe('API de autenticación', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => {
    await ctx?.stop();
  });

  test('login correcto abre sesión y /me devuelve el usuario', async () => {
    const call = ctx.client();
    const login = await call('POST', '/api/auth/login', { email: ' Admin@Puntapie.test ', password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.email, ADMIN_EMAIL);
    assert.equal(login.data.role, 'admin');
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.name, 'Iván');
  });

  test('login con contraseña o correo incorrectos devuelve el mismo error', async () => {
    const call = ctx.client();
    const wrongPass = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'mala' });
    const wrongMail = await call('POST', '/api/auth/login', { email: 'nadie@x.es', password: 'mala' });
    assert.equal(wrongPass.status, 401);
    assert.equal(wrongMail.status, 401);
    assert.equal(wrongPass.error, wrongMail.error);
  });

  test('logout cierra la sesión', async () => {
    const call = ctx.client();
    await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    await call('POST', '/api/auth/logout');
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.status, 401);
  });

  test('forgot-password responde igual para cuentas inexistentes y no envía correo', async () => {
    const before = ctx.sentMail.length;
    const res = await ctx.client()('POST', '/api/auth/forgot-password', { email: 'nadie@puntapie.test' });
    assert.equal(res.status, 200);
    assert.match(res.data.message, /Si el correo pertenece/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ctx.sentMail.length, before);
  });

  test('forgot-password rechaza correos con formato inválido', async () => {
    const res = await ctx.client()('POST', '/api/auth/forgot-password', { email: 'no-es-correo' });
    assert.equal(res.status, 400);
  });

  test('flujo completo: enlace válido, cambio de contraseña, un solo uso y sesiones cerradas', async () => {
    const oldSession = ctx.client();
    await oldSession('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    const count = ctx.sentMail.length + 1;
    await ctx.client()('POST', '/api/auth/forgot-password', { email: ADMIN_EMAIL });
    const mail = await ctx.waitForMail(count);
    assert.ok(mail.link.startsWith('http://puntapie.test/restablecer?token='));
    const token = tokenFromLink(mail.link);

    const call = ctx.client();
    const check = await call('POST', '/api/auth/reset-password/check', { token });
    assert.equal(check.data.valid, true);

    const weak = await call('POST', '/api/auth/reset-password', { token, newPassword: 'abc', confirmPassword: 'abc' });
    assert.equal(weak.status, 400);

    const newPassword = 'NuevaClave2026';
    const reset = await call('POST', '/api/auth/reset-password', { token, newPassword, confirmPassword: newPassword });
    assert.equal(reset.status, 200);

    const reuse = await call('POST', '/api/auth/reset-password', { token, newPassword, confirmPassword: newPassword });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.code, 'RESET_TOKEN_INVALID');

    assert.equal((await oldSession('GET', '/api/auth/me')).status, 401);
    const oldLogin = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.equal(oldLogin.status, 401);
    const newLogin = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: newPassword });
    assert.equal(newLogin.status, 200);
  });

  test('pedir un enlace nuevo invalida el anterior; los caducados no sirven', async () => {
    const call = ctx.client();
    let count = ctx.sentMail.length + 1;
    await call('POST', '/api/auth/forgot-password', { email: ADMIN_EMAIL });
    const first = tokenFromLink((await ctx.waitForMail(count)).link);
    count += 1;
    await call('POST', '/api/auth/forgot-password', { email: ADMIN_EMAIL });
    const second = tokenFromLink((await ctx.waitForMail(count)).link);

    assert.equal((await call('POST', '/api/auth/reset-password/check', { token: first })).data.valid, false);
    assert.equal((await call('POST', '/api/auth/reset-password/check', { token: second })).data.valid, true);

    await ctx.pool.query("UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 minute'");
    assert.equal((await call('POST', '/api/auth/reset-password/check', { token: second })).data.valid, false);
  });

  test('/api/health confirma la conexión a la base de datos', async () => {
    const health = await ctx.client()('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ok');
  });
});
