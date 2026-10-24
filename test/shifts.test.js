import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { buildStaffing, computeStaffStats, simulatedSchedules } from '../src/services/staff-stats.js';
import { REGULAR_SLOTS } from '../src/services/shop-hours.js';

describe('ventas por empleado (cálculo)', () => {
  // Elena: lunes y martes por la mañana. Raquel: lunes mañana y tarde.
  const members = [{ id: 1, name: 'Elena' }, { id: 2, name: 'Raquel' }];
  const schedules = [
    { userId: 1, validFrom: '2026-01-01', slots: ['1-manana', '2-manana'] },
    { userId: 2, validFrom: '2026-01-01', slots: ['1-manana', '1-tarde'] },
  ];
  const sales = [
    { at: '2026-10-05T11:00', cents: 40000 }, // lunes mañana: Elena + Raquel
    { at: '2026-10-05T18:00', cents: 60000 }, // lunes tarde: Raquel
    { at: '2026-10-06T11:00', cents: 20000 }, // martes mañana: Elena
    { at: '2026-10-11T11:00', cents: 30000 }, // domingo (apertura extra): Elena
  ];

  test('cada uno se lleva el total de los turnos en los que estaba', () => {
    const staffing = buildStaffing({ members, schedules, openings: [{ day: '2026-10-11', shift: 'manana', staff: [1] }] });
    assert.deepEqual(staffing('2026-10-05', 'manana'), [1, 2]);
    assert.deepEqual(staffing('2026-10-11', 'manana'), [1]);
    const stats = computeStaffStats({ sales, members, staffing });
    const elena = stats.rows.find((r) => r.id === 1);
    const raquel = stats.rows.find((r) => r.id === 2);
    assert.equal(elena.shifts, 3);
    assert.equal(elena.cents, 90000);
    assert.equal(elena.avgPerShiftCents, 30000);
    assert.equal(raquel.shifts, 2);
    assert.equal(raquel.avgPerShiftCents, 50000);
    // Media de la tienda: mañana (40+20+30)/3 = 300 €; tarde 600 €.
    assert.equal(stats.store.byShift.manana.avgCents, 30000);
    // Raquel: 1.000 € frente a 300 + 600 esperados → 111 %. Elena: 900 frente a 900 → 100 %.
    assert.ok(Math.abs(raquel.index - 1000 / 900) < 1e-9);
    assert.ok(Math.abs(elena.index - 1) < 1e-9);
    assert.equal(stats.rows[0].id, 2, 'se ordena por índice');
  });

  test('vacaciones, turnos libres, contrato y baja sacan a la persona del turno', () => {
    const staffing = buildStaffing({
      members: [{ id: 1, name: 'Elena', contractStart: '2026-10-06' }, { id: 2, name: 'Raquel', leftOn: '2026-10-05' }],
      schedules: [{ userId: 1, validFrom: '2026-01-01', slots: REGULAR_SLOTS }, { userId: 2, validFrom: '2026-01-01', slots: REGULAR_SLOTS }],
      vacations: [{ userId: 1, start: '2026-10-08', end: '2026-10-09' }],
      freeShifts: [{ userId: 1, day: '2026-10-07', shift: 'tarde' }],
    });
    assert.deepEqual(staffing('2026-10-05', 'manana'), [2]);
    assert.deepEqual(staffing('2026-10-06', 'manana'), [1]);
    assert.deepEqual(staffing('2026-10-07', 'manana'), [1]);
    assert.deepEqual(staffing('2026-10-07', 'tarde'), []);
    assert.deepEqual(staffing('2026-10-08', 'manana'), []);
  });

  test('el turno que vale es el vigente en cada fecha', () => {
    const staffing = buildStaffing({
      members: [{ id: 1, name: 'Elena' }],
      schedules: [{ userId: 1, validFrom: '2026-01-01', slots: ['1-manana'] }, { userId: 1, validFrom: '2026-10-10', slots: ['1-tarde'] }],
    });
    assert.deepEqual(staffing('2026-10-05', 'manana'), [1]);
    assert.deepEqual(staffing('2026-10-12', 'manana'), []);
    assert.deepEqual(staffing('2026-10-12', 'tarde'), [1]);
  });

  test('la simulación reparte todos los turnos', () => {
    const team = simulatedSchedules([{ id: 1 }, { id: 2 }, { id: 3 }], '2026-01-01');
    for (const slot of REGULAR_SLOTS) assert.ok(team.some((s) => s.slots.includes(slot)), slot);
  });
});

describe('API de turnos, aperturas extra, horas bonificadas y log', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elenaId;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elenaId = (await admin('GET', '/api/admin/users')).data.find((u) => u.username === 'epena').id;
  });
  after(async () => {
    await ctx?.stop();
  });

  test('turno fijo: solo turnos del horario normal y con historial', async () => {
    const bad = await admin('PUT', `/api/admin/users/${elenaId}/turno`, { slots: ['6-tarde'], validFrom: '2026-01-01' });
    assert.equal(bad.status, 400);
    const saved = await admin('PUT', `/api/admin/users/${elenaId}/turno`, { slots: ['2-manana', '1-manana', '6-manana'], validFrom: '2026-01-01' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.current.slots, ['1-manana', '2-manana', '6-manana']);
  });

  test('aperturas extra: solo sábado tarde o domingo mañana, sin repetir', async () => {
    assert.equal((await admin('POST', '/api/admin/aperturas', { day: '2026-10-05', shift: 'manana', staff: [] })).status, 400);
    assert.equal((await admin('POST', '/api/admin/aperturas', { day: '2026-10-11', shift: 'tarde', staff: [] })).status, 400);
    const sunday = await admin('POST', '/api/admin/aperturas', { day: '2026-10-11', shift: 'manana', staff: [elenaId], note: 'Bonos consumo' });
    assert.equal(sunday.status, 201);
    assert.deepEqual(sunday.data.staff.map((p) => p.id), [elenaId]);
    assert.equal((await admin('POST', '/api/admin/aperturas', { day: '2026-10-11', shift: 'manana', staff: [] })).status, 409);
    const saturday = await admin('POST', '/api/admin/aperturas', { day: '2026-10-10', shift: 'tarde', staff: [elenaId] });
    assert.equal(saturday.status, 201);
  });

  test('horas bonificadas: 7 h por apertura trabajada y 3,5 h por turno libre', async () => {
    const overview = await admin('GET', `/api/admin/users/${elenaId}/horas`);
    assert.equal(overview.data.earnedMinutes, 2 * 420);
    assert.equal(overview.data.freeShiftsAvailable, 4);

    // Martes mañana es su turno; martes tarde no.
    const notHers = await admin('POST', `/api/admin/users/${elenaId}/horas`, { day: '2026-10-13', shift: 'tarde' });
    assert.equal(notHers.status, 409);
    assert.equal(notHers.code, 'NOT_IN_SCHEDULE');
    const free = await admin('POST', `/api/admin/users/${elenaId}/horas`, { day: '2026-10-13', shift: 'manana', note: 'Médico' });
    assert.equal(free.status, 201);
    assert.equal(free.data.balanceMinutes, 840 - 210);
    assert.equal((await admin('POST', `/api/admin/users/${elenaId}/horas`, { day: '2026-10-13', shift: 'manana' })).status, 409);

    // Se gastan las 4 y ya no queda.
    for (const day of ['2026-10-19', '2026-10-20', '2026-10-24']) {
      assert.equal((await admin('POST', `/api/admin/users/${elenaId}/horas`, { day, shift: 'manana' })).status, 201, day);
    }
    const none = await admin('POST', `/api/admin/users/${elenaId}/horas`, { day: '2026-10-26', shift: 'manana' });
    assert.equal(none.code, 'NO_BONUS_LEFT');

    const removed = await admin('DELETE', `/api/admin/users/${elenaId}/horas/${free.data.freeShifts.find((f) => f.day === '2026-10-13').id}`);
    assert.equal(removed.data.balanceMinutes, 210);

    // Con 3,5 h de saldo, borrar una apertura trabajada (−7 h) lo dejaría en negativo.
    const openings = await admin('GET', '/api/admin/aperturas');
    const sunday = openings.data.find((o) => o.day === '2026-10-11');
    const blocked = await admin('DELETE', `/api/admin/aperturas/${sunday.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, 'BONUS_ALREADY_USED');
    assert.equal((await admin('PATCH', `/api/admin/aperturas/${sunday.id}`, { staff: [] })).code, 'BONUS_ALREADY_USED');
  });

  test('el log guarda quién, qué, campo, valor previo y nuevo', async () => {
    await admin('PATCH', `/api/admin/users/${elenaId}`, { name: 'Elena Peña' });
    const log = await admin('GET', '/api/admin/log?area=usuarios');
    const row = log.data.items.find((i) => i.field === 'Nombre');
    assert.equal(row.userName, 'Iván');
    assert.equal(row.action, 'editar');
    assert.equal(row.oldValue, 'Elena');
    assert.equal(row.newValue, 'Elena Peña');
    assert.equal(row.target, 'Elena Peña');

    const turnos = await admin('GET', '/api/admin/log?area=turnos');
    assert.match(turnos.data.items[0].newValue, /Lunes mañana/);

    const failed = await ctx.client()('POST', '/api/auth/login', { identifier: 'nadie', password: 'x' });
    assert.equal(failed.status, 401);
    const session = await admin('GET', '/api/admin/log?accion=entrar_fallido');
    assert.equal(session.data.items[0].target, 'nadie');
    assert.equal(session.data.items[0].userId, null);

    const search = await admin('GET', '/api/admin/log?q=Médico');
    assert.ok(search.data.total >= 1);
    assert.equal((await admin('GET', '/api/admin/log?area=nada')).status, 400);
  });

  test('ventas por empleado: solo el Administrador, y sin quien solo gestiona', async () => {
    const users = (await admin('GET', '/api/admin/users')).data;
    const ivan = users.find((u) => u.username === 'ifebles');
    assert.equal(ivan.isSeller, false, 'Iván administra, no vende');
    await admin('PUT', `/api/admin/users/${ivan.id}/turno`, { slots: ['1-manana'], validFrom: '2026-01-01' });
    const res = await admin('GET', '/api/estadisticas/empleados?periodo=3m&simular=1');
    assert.equal(res.status, 200);
    assert.ok(res.data.rows.some((r) => r.id === elenaId && r.shifts > 0));
    assert.ok(!res.data.rows.some((r) => r.id === ivan.id), 'Iván no sale en las ventas');

    const raquel = users.find((u) => u.username === 'rperez');
    const off = await admin('PATCH', `/api/admin/users/${raquel.id}`, { isSeller: false });
    assert.equal(off.data.isSeller, false);
    const log = await admin('GET', '/api/admin/log?area=usuarios&q=Vende');
    assert.equal(log.data.items[0].newValue, 'No (solo gestiona)');
    await admin('PATCH', `/api/admin/users/${raquel.id}`, { isSeller: true });

    const elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    assert.equal((await elena('GET', '/api/estadisticas/empleados?periodo=3m')).status, 403);
    assert.equal((await elena('GET', '/api/admin/log')).status, 403);
    assert.equal((await elena('GET', '/api/estadisticas/exportar?periodo=3m')).status, 403, 'el Excel lleva quién estaba en cada turno');
  });
});
