import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { readVacation } from '../src/services/vacations.js';

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

describe('readVacation', () => {
  test('valida fechas, orden, duración y nota', () => {
    assert.deepEqual(readVacation({ start: '2026-08-01', end: '2026-08-15', note: ' Verano ' }),
      { start: '2026-08-01', end: '2026-08-15', note: 'Verano' });
    assert.throws(() => readVacation({ start: '2026-02-30', end: '2026-03-01' }), /inicio no es válida/);
    assert.throws(() => readVacation({ start: '01/08/2026', end: '2026-08-02' }), /inicio no es válida/);
    assert.throws(() => readVacation({ start: '2026-08-10', end: '2026-08-01' }), /anterior/);
    assert.throws(() => readVacation({ start: '2026-01-01', end: '2027-06-01' }), /366 días/);
    assert.throws(() => readVacation({ start: '2026-01-01', end: '2026-01-02', note: 'x'.repeat(201) }), /nota/);
  });
});

describe('vacaciones del equipo', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elena;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elena = (await admin('GET', '/api/admin/users')).data.find((u) => u.username === 'epena');
  });
  after(async () => {
    await ctx?.stop();
  });

  test('añade, lista y cuenta los días de cada periodo', async () => {
    const res = await admin('POST', `/api/admin/users/${elena.id}/vacations`, {
      start: '2026-08-03', end: '2026-08-16', note: 'Verano',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.days, 14);
    assert.equal(res.data.start, '2026-08-03');

    const list = await admin('GET', `/api/admin/users/${elena.id}/vacations`);
    assert.equal(list.data.periods.length, 1);
    assert.equal(list.data.periods[0].note, 'Verano');
    assert.equal(list.data.contractStart, null);
    assert.equal(list.data.summary.entitled, 30);
  });

  test('rechaza periodos que se solapan', async () => {
    const res = await admin('POST', `/api/admin/users/${elena.id}/vacations`, { start: '2026-08-15', end: '2026-08-20' });
    assert.equal(res.status, 409);
    assert.equal(res.code, 'VACATION_OVERLAP');
    assert.match(res.error, /03\/08\/2026/);
  });

  test('la lista del equipo marca quién está de vacaciones hoy y las próximas', async () => {
    await admin('POST', `/api/admin/users/${elena.id}/vacations`, { start: isoDay(-1), end: isoDay(2) });
    const team = await admin('GET', '/api/admin/users');
    const row = team.data.find((u) => u.id === elena.id);
    assert.equal(row.onVacationUntil, isoDay(2));
    const ivan = team.data.find((u) => u.email === ADMIN_EMAIL);
    assert.equal(ivan.onVacationUntil, null);
    assert.equal(ivan.nextVacation, null);
  });

  test('borra un periodo y avisa si no existe', async () => {
    const list = await admin('GET', `/api/admin/users/${elena.id}/vacations`);
    const target = list.data.periods.find((v) => v.note === 'Verano');
    const del = await admin('DELETE', `/api/admin/users/${elena.id}/vacations/${target.id}`);
    assert.equal(del.status, 200);
    const again = await admin('DELETE', `/api/admin/users/${elena.id}/vacations/${target.id}`);
    assert.equal(again.status, 404);
    const wrongUser = await admin('DELETE', `/api/admin/users/99999/vacations/${target.id}`);
    assert.equal(wrongUser.status, 404);
  });

  test('la fecha de inicio de contrato prorratea los días del año', async () => {
    const year = new Date().getFullYear();
    const res = await admin('PUT', `/api/admin/users/${elena.id}/contract-start`, { contractStart: `${year}-07-07` });
    assert.equal(res.status, 200);
    assert.equal(res.data.contractStart, `${year}-07-07`);
    assert.equal(res.data.summary.prorated, true);
    assert.equal(res.data.summary.entitled, 15);
    const remaining = res.data.summary.entitled - res.data.summary.taken - res.data.summary.planned;
    assert.equal(res.data.summary.remaining, remaining);

    const bad = await admin('PUT', `/api/admin/users/${elena.id}/contract-start`, { contractStart: '2026-13-01' });
    assert.equal(bad.status, 400);
    const cleared = await admin('PUT', `/api/admin/users/${elena.id}/contract-start`, { contractStart: null });
    assert.equal(cleared.data.contractStart, null);
    assert.equal(cleared.data.summary.entitled, 30);
  });

  test('los días pendientes del año anterior se pueden fijar a mano y volver al cálculo', async () => {
    const set = await admin('PUT', `/api/admin/users/${elena.id}/carryover`, { days: 6 });
    assert.equal(set.status, 200);
    assert.equal(set.data.summary.carryOver, 6);
    assert.equal(set.data.summary.carryOverSource, 'manual');
    assert.equal(set.data.summary.available, set.data.summary.entitled + 6);

    const bad = await admin('PUT', `/api/admin/users/${elena.id}/carryover`, { days: 2.5 });
    assert.equal(bad.status, 400);
    const tooMany = await admin('PUT', `/api/admin/users/${elena.id}/carryover`, { days: 61 });
    assert.equal(tooMany.status, 400);

    const auto = await admin('PUT', `/api/admin/users/${elena.id}/carryover`, { days: null });
    assert.notEqual(auto.data.summary.carryOverSource, 'manual');
  });

  test('solo el Administrador gestiona vacaciones', async () => {
    const res = await ctx.client()('GET', `/api/admin/users/${elena.id}/vacations`);
    assert.equal(res.status, 401);
  });
});
