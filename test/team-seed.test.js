import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { TEAM_SEED, seedTeam } from '../src/db/seed-team.js';
import { verifyPassword } from '../src/auth/password.js';

const INITIAL_PASSWORD = 'Test1234';
const NEW_PASSWORD = 'Puntapie2026';

describe('equipo inicial', () => {
  test('las contraseñas iniciales van hasheadas y corresponden a Test1234', async () => {
    assert.deepEqual(TEAM_SEED.map((m) => [m.username, m.name, m.role]), [
      ['ctoriz', 'Claudia', 'admin'], ['epena', 'Elena', 'empleado'],
      ['rperez', 'Raquel', 'empleado'], ['ifebles', 'Iván', 'admin'],
    ]);
    for (const member of TEAM_SEED) {
      assert.match(member.passwordHash, /^\$2[aby]\$12\$/);
      assert.equal(await verifyPassword(INITIAL_PASSWORD, member.passwordHash), true);
    }
  });
});

describe('acceso del equipo inicial', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(async () => {
    await ctx?.stop();
  });

  test('entra con su usuario (sin distinguir mayúsculas) y debe cambiar la contraseña', async () => {
    const call = ctx.client();
    const login = await call('POST', '/api/auth/login', { identifier: 'EPena', password: INITIAL_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.username, 'epena');
    assert.equal(login.data.role, 'empleado');
    assert.equal(login.data.mustChangePassword, true);
  });

  test('mientras no la cambie, el resto de la API le está vetada', async () => {
    const call = await ctx.loginAs('ctoriz', INITIAL_PASSWORD);
    const res = await call('GET', '/api/admin/users');
    assert.equal(res.status, 403);
    assert.equal(res.code, 'PASSWORD_CHANGE_REQUIRED');
  });

  test('cambiar la contraseña desbloquea la cuenta y la inicial deja de valer', async () => {
    const call = await ctx.loginAs('ctoriz', INITIAL_PASSWORD);
    const same = await call('POST', '/api/auth/change-password', {
      newPassword: INITIAL_PASSWORD, confirmPassword: INITIAL_PASSWORD,
    });
    assert.equal(same.status, 400, 'no puede repetir la inicial');

    const changed = await call('POST', '/api/auth/change-password', {
      newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.mustChangePassword, false);

    const me = await call('GET', '/api/auth/me');
    assert.equal(me.data.mustChangePassword, false);
    assert.equal((await call('GET', '/api/admin/users')).status, 200, 'ctoriz es admin');

    const old = await ctx.client()('POST', '/api/auth/login', { identifier: 'ctoriz', password: INITIAL_PASSWORD });
    assert.equal(old.status, 401);
  });

  test('un cambio voluntario exige la contraseña actual', async () => {
    const call = await ctx.loginAs('ctoriz', NEW_PASSWORD);
    const res = await call('POST', '/api/auth/change-password', {
      currentPassword: 'mala', newPassword: 'OtraClave2026', confirmPassword: 'OtraClave2026',
    });
    assert.equal(res.status, 400);
  });

  test('corrige el nombre provisional pero no uno ya editado', async () => {
    await ctx.pool.query("UPDATE users SET name = 'epena' WHERE username = 'epena'");
    await ctx.pool.query("UPDATE users SET name = 'Claudia T.' WHERE username = 'ctoriz'");
    await seedTeam(ctx.pool, undefined, { info() {} });
    const names = await ctx.pool.query("SELECT username, name FROM users WHERE username IN ('epena', 'ctoriz') ORDER BY username");
    assert.deepEqual(names.rows.map((r) => r.name), ['Claudia T.', 'Elena']);
  });

  test('el seed no pisa cuentas existentes ni contraseñas ya cambiadas', async () => {
    await seedTeam(ctx.pool, undefined, { info() {} });
    const count = await ctx.pool.query("SELECT count(*)::int AS n FROM users WHERE username = 'ctoriz'");
    assert.equal(count.rows[0].n, 1);
    const login = await ctx.client()('POST', '/api/auth/login', { identifier: 'ctoriz', password: NEW_PASSWORD });
    assert.equal(login.status, 200);
  });

  test('Admin puede ponerle correo y una contraseña provisional', async () => {
    const admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const list = await admin('GET', '/api/admin/users');
    const rperez = list.data.find((u) => u.username === 'rperez');
    assert.equal(rperez.email, null);
    assert.equal(rperez.mustChangePassword, true);

    const noMail = await admin('POST', `/api/admin/users/${rperez.id}/send-access`);
    assert.equal(noMail.code, 'NO_EMAIL');

    const temp = await admin('POST', `/api/admin/users/${rperez.id}/temporary-password`);
    assert.equal(temp.status, 200);
    assert.match(temp.data.temporaryPassword, /^[a-z]{6}-\d{4}$/);
    assert.equal(temp.data.user.mustChangePassword, true);
    const loginTemp = await ctx.client()('POST', '/api/auth/login', { identifier: 'rperez', password: temp.data.temporaryPassword });
    assert.equal(loginTemp.data.mustChangePassword, true);

    const withMail = await admin('PATCH', `/api/admin/users/${rperez.id}`, { email: 'RPerez@Puntapie.test', name: 'Raquel Pérez' });
    assert.equal(withMail.data.email, 'rperez@puntapie.test');
    const byMail = await ctx.client()('POST', '/api/auth/login', { identifier: 'rperez@puntapie.test', password: temp.data.temporaryPassword });
    assert.equal(byMail.status, 200);

    const taken = await admin('PATCH', `/api/admin/users/${rperez.id}`, { email: ADMIN_EMAIL });
    assert.equal(taken.code, 'EMAIL_TAKEN');
  });

  test('nadie se pone a sí mismo una contraseña provisional', async () => {
    const admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const me = (await admin('GET', '/api/auth/me')).data;
    const res = await admin('POST', `/api/admin/users/${me.id}/temporary-password`);
    assert.equal(res.code, 'SELF_PASSWORD');
  });
});
