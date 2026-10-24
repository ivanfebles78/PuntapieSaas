import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer, tokenFromLink } from './helpers.js';

const NEW_PASSWORD = 'ClaveNueva2026';

describe('Módulo Admin: gestión del equipo', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  // Invita, acepta la invitación y devuelve el id y una sesión de esa persona.
  async function inviteAndAccept(email, role, name = 'Prueba') {
    const created = await admin('POST', '/api/admin/users', { email, name, role });
    assert.equal(created.status, 201, created.error);
    const mail = ctx.sentMail.at(-1);
    const token = tokenFromLink(mail.link);
    const call = ctx.client();
    const accepted = await call('POST', '/api/auth/reset-password', {
      token, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    });
    assert.equal(accepted.status, 200, accepted.error);
    return { id: created.data.user.id, session: await ctx.loginAs(email, NEW_PASSWORD) };
  }

  test('lista el equipo con estado y rol', async () => {
    const res = await admin('GET', '/api/admin/users');
    assert.equal(res.status, 200);
    const me = res.data.find((u) => u.email === ADMIN_EMAIL);
    assert.equal(me.role, 'admin');
    assert.equal(me.status, 'activo');
    assert.ok(me.lastLoginAt, 'registra el último acceso');
  });

  test('lista los roles disponibles', async () => {
    const res = await admin('GET', '/api/admin/roles');
    assert.deepEqual(res.data.map((r) => r.id), ['admin', 'asesor', 'empleado']);
    assert.equal(res.data[0].label, 'Administrador');
  });

  test('dar de alta crea una cuenta invitada y envía la invitación', async () => {
    const res = await admin('POST', '/api/admin/users', {
      email: ' Claudia@Puntapie.test ', name: '  Claudia   Pérez ', role: 'empleado',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.email, 'claudia@puntapie.test');
    assert.equal(res.data.user.name, 'Claudia Pérez');
    assert.equal(res.data.user.status, 'invitado');
    assert.equal(res.data.user.invitedBy, 'Iván');
    assert.equal(res.data.mailSent, true);
    assert.equal(res.data.kind, 'invite');

    const mail = ctx.sentMail.at(-1);
    assert.equal(mail.kind, 'invite');
    assert.equal(mail.to, 'claudia@puntapie.test');
    assert.equal(mail.invitedBy, 'Iván');

    const check = await ctx.client()('POST', '/api/auth/reset-password/check', { token: tokenFromLink(mail.link) });
    assert.deepEqual(check.data, { valid: true, purpose: 'invite' });
  });

  test('una cuenta invitada no puede entrar hasta crear su contraseña', async () => {
    const res = await ctx.client()('POST', '/api/auth/login', { email: 'claudia@puntapie.test', password: '' });
    assert.equal(res.status, 400);
    const wrong = await ctx.client()('POST', '/api/auth/login', { email: 'claudia@puntapie.test', password: 'Cualquiera1' });
    assert.equal(wrong.status, 401);
  });

  test('aceptar la invitación activa la cuenta', async () => {
    const { id, session } = await inviteAndAccept('elena@puntapie.test', 'empleado', 'Elena');
    const me = await session('GET', '/api/auth/me');
    assert.equal(me.data.role, 'empleado');
    const list = await admin('GET', '/api/admin/users');
    assert.equal(list.data.find((u) => u.id === id).status, 'activo');
  });

  test('rechaza correos duplicados y datos no válidos', async () => {
    const dup = await admin('POST', '/api/admin/users', { email: ADMIN_EMAIL, name: 'Otro', role: 'empleado' });
    assert.equal(dup.status, 409);
    assert.equal(dup.code, 'EMAIL_TAKEN');
    const badRole = await admin('POST', '/api/admin/users', { email: 'x@puntapie.test', name: 'X', role: 'jefe' });
    assert.equal(badRole.status, 400);
    const badMail = await admin('POST', '/api/admin/users', { email: 'nope', name: 'X', role: 'empleado' });
    assert.equal(badMail.status, 400);
    const noName = await admin('POST', '/api/admin/users', { email: 'y@puntapie.test', name: '  ', role: 'empleado' });
    assert.equal(noName.status, 400);
  });

  test('solo el Administrador accede al módulo', async () => {
    const { session } = await inviteAndAccept('raquel@puntapie.test', 'empleado', 'Raquel');
    const res = await session('GET', '/api/admin/users');
    assert.equal(res.status, 403);
    const create = await session('POST', '/api/admin/users', { email: 'z@puntapie.test', name: 'Z', role: 'admin' });
    assert.equal(create.status, 403);
    const anon = await ctx.client()('GET', '/api/admin/users');
    assert.equal(anon.status, 401);
  });

  test('cambiar el rol y el nombre de otra persona', async () => {
    const { id } = await inviteAndAccept('asesor@puntapie.test', 'empleado', 'Asesor');
    const res = await admin('PATCH', `/api/admin/users/${id}`, { role: 'admin', name: 'Gestoría López' });
    assert.equal(res.status, 200);
    assert.equal(res.data.role, 'admin');
    assert.equal(res.data.name, 'Gestoría López');
  });

  test('nadie puede cambiar su propio rol ni darse de baja', async () => {
    const list = await admin('GET', '/api/admin/users');
    const me = list.data.find((u) => u.email === ADMIN_EMAIL);
    const role = await admin('PATCH', `/api/admin/users/${me.id}`, { role: 'empleado' });
    assert.equal(role.code, 'SELF_ROLE');
    const off = await admin('POST', `/api/admin/users/${me.id}/deactivate`);
    assert.equal(off.code, 'SELF_DEACTIVATE');
  });

  test('siempre queda al menos un Administrador activo', async () => {
    const { id, session } = await inviteAndAccept('segundo@puntapie.test', 'admin', 'Segundo');
    const list = await admin('GET', '/api/admin/users');
    const me = list.data.find((u) => u.email === ADMIN_EMAIL);
    // El segundo admin degrada al primero: permitido porque quedan dos.
    const demote = await session('PATCH', `/api/admin/users/${me.id}`, { role: 'empleado' });
    assert.equal(demote.status, 200);
    // Ahora el segundo es el único: el primero (ya no admin) no puede tocarlo.
    const forbidden = await admin('POST', `/api/admin/users/${id}/deactivate`);
    assert.equal(forbidden.status, 403);
    // Se restaura el rol original para el resto de pruebas.
    const restore = await session('PATCH', `/api/admin/users/${me.id}`, { role: 'admin' });
    assert.equal(restore.status, 200);
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('dar de baja cierra sus sesiones e impide entrar; reactivar lo devuelve', async () => {
    const { id, session } = await inviteAndAccept('baja@puntapie.test', 'empleado', 'Baja');
    const off = await admin('POST', `/api/admin/users/${id}/deactivate`);
    assert.equal(off.status, 200);
    assert.equal(off.data.status, 'baja');
    assert.ok(off.data.deactivatedAt);
    assert.equal((await session('GET', '/api/auth/me')).status, 401);
    const login = await ctx.client()('POST', '/api/auth/login', { email: 'baja@puntapie.test', password: NEW_PASSWORD });
    assert.equal(login.status, 401);
    const send = await admin('POST', `/api/admin/users/${id}/send-access`);
    assert.equal(send.code, 'USER_INACTIVE');

    const on = await admin('POST', `/api/admin/users/${id}/reactivate`);
    assert.equal(on.data.status, 'activo');
    const again = await ctx.client()('POST', '/api/auth/login', { email: 'baja@puntapie.test', password: NEW_PASSWORD });
    assert.equal(again.status, 200);
  });

  test('enviar acceso: invitación si no tiene contraseña, enlace de restablecer si la tiene', async () => {
    const pending = await admin('POST', '/api/admin/users', { email: 'pendiente@puntapie.test', name: 'Pendiente', role: 'empleado' });
    const firstInvite = tokenFromLink(ctx.sentMail.at(-1).link);
    const resend = await admin('POST', `/api/admin/users/${pending.data.user.id}/send-access`);
    assert.equal(resend.data.kind, 'invite');
    assert.equal(ctx.sentMail.at(-1).kind, 'invite');
    const oldCheck = await ctx.client()('POST', '/api/auth/reset-password/check', { token: firstInvite });
    assert.equal(oldCheck.data.valid, false, 'el reenvío anula la invitación anterior');

    const { id } = await inviteAndAccept('reset@puntapie.test', 'empleado', 'Reset');
    const reset = await admin('POST', `/api/admin/users/${id}/send-access`);
    assert.equal(reset.data.kind, 'reset');
    assert.equal(ctx.sentMail.at(-1).kind, 'reset');
    assert.equal(ctx.sentMail.at(-1).to, 'reset@puntapie.test');
  });

  test('usuario inexistente devuelve 404', async () => {
    assert.equal((await admin('PATCH', '/api/admin/users/99999', { name: 'X' })).status, 404);
    assert.equal((await admin('POST', '/api/admin/users/abc/deactivate')).status, 404);
  });
});
