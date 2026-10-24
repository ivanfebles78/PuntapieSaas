import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

describe('rol Asesor: lo ve todo y no cambia nada', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let asesor;
  let raquelId;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    raquelId = (await admin('GET', '/api/admin/users')).data.find((u) => u.username === 'rperez').id;
    const changed = await admin('PATCH', `/api/admin/users/${raquelId}`, { role: 'asesor' });
    assert.equal(changed.data.role, 'asesor');
    asesor = await ctx.loginAs('rperez', 'Test1234');
    // Cambiar su propia contraseña sí puede: es su cuenta, no datos de la tienda.
    const own = await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal(own.status, 200);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('puede leer Admin, Gastos y Estadísticas (también la de empleados)', async () => {
    for (const path of ['/api/admin/users', '/api/admin/log', '/api/admin/aperturas', `/api/admin/users/${raquelId}/vacations`,
      `/api/admin/users/${raquelId}/turno`, `/api/admin/users/${raquelId}/horas`, '/api/gastos?mes=2026-10',
      '/api/estadisticas?periodo=3m', '/api/estadisticas/empleados?periodo=3m']) {
      assert.equal((await asesor('GET', path)).status, 200, path);
    }
  });

  test('cualquier cambio se rechaza con 403', async () => {
    const attempts = [
      ['POST', '/api/admin/users', { name: 'X', email: 'x@x.es', role: 'empleado' }],
      ['PATCH', `/api/admin/users/${raquelId}`, { name: 'Otra' }],
      ['PUT', `/api/admin/users/${raquelId}/turno`, { slots: ['1-manana'] }],
      ['POST', '/api/admin/aperturas', { day: '2026-10-11', shift: 'manana', staff: [] }],
      ['POST', '/api/gastos', { name: 'Luz', category: 'recurrente', kind: 'fijo', amount: '10', startMonth: '2026-10' }],
      ['PUT', '/api/estadisticas/objetivos', { daily: 1, weekly: 1, monthly: 1 }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await asesor(method, path, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.code, 'READ_ONLY');
    }
  });

  test('el cambio de rol queda en el log', async () => {
    const log = await admin('GET', '/api/admin/log?area=usuarios');
    const row = log.data.items.find((i) => i.field === 'Rol');
    assert.equal(row.oldValue, 'Empleado');
    assert.equal(row.newValue, 'Asesor');
  });
});
