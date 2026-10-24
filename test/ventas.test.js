import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { readDayInput } from '../src/services/daily-sales.js';
import { typoFixes } from '../src/services/sales-import.js';

test('la tarde es el total del día menos la mañana', () => {
  const { manana, tarde } = readDayInput({
    manana: { tarjeta: { importe: '104,78', clientes: '3' } },
    dia: { tarjeta: { importe: '249,06' }, efectivo: { importe: '85,64' } },
    tarde: { tarjeta: { clientes: 4 }, efectivo: { clientes: 2 } },
  });
  assert.deepEqual(manana.tarjeta, { cents: 10478, customers: 3 });
  assert.deepEqual(tarde.tarjeta, { cents: 14428, customers: 4 });
  assert.deepEqual(tarde.efectivo, { cents: 8564, customers: 2 });
  assert.throws(() => readDayInput({ manana: { bizum: { importe: 50 } }, dia: { bizum: { importe: 20 } } }), /no puede ser menor/);
  assert.throws(() => readDayInput({ manana: { bizum: { clientes: -1 } } }), /clientes/);
});

test('erratas de clientes señaladas en incidencias.csv', () => {
  const fixes = typoFixes('fecha,incidencia\n2026-08-19,"tarde/efectivo: 30 clientes para 58,42 € (probable error de tecleo, ¿3?)"\n2026-04-17,manana/tarjeta: importe 104.78 con 0 clientes\n');
  assert.deepEqual([...fixes.entries()], [['2026-08-19|tarde|efectivo', { from: 30, to: 3 }]]);
});

describe('API de caja diaria', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('apuntar un día a mano, con vales aparte', async () => {
    const res = await admin('PUT', '/api/ventas/dia/2026-10-20', {
      manana: { tarjeta: { importe: '200', clientes: 4 }, efectivo: { importe: '50,5', clientes: 1 } },
      dia: { tarjeta: { importe: '500' }, efectivo: { importe: '50,50' }, vales: { importe: '30' } },
      tarde: { tarjeta: { clientes: 6 }, vales: { clientes: 1 } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.totals.manana, { cents: 25050, customers: 5 });
    assert.deepEqual(res.data.totals.tarde, { cents: 30000, customers: 6 });
    assert.equal(res.data.totals.vales.cents, 3000);
    const again = await admin('GET', '/api/ventas/dia/2026-10-20');
    assert.equal(again.data.tarde.tarjeta.cents, 30000);
    const list = await admin('GET', '/api/ventas/dias?desde=2026-10-01&hasta=2026-10-31');
    assert.deepEqual(list.data.map((d) => [d.day, d.cents, d.customers]), [['2026-10-20', 55050, 11]]);
    const log = await admin('GET', '/api/admin/log?area=ventas');
    assert.ok(log.data.items.some((i) => i.field === 'Tarde · Tarjeta'));
  });

  test('un festivo no guarda ventas; un total menor que la mañana se rechaza', async () => {
    const festivo = await admin('PUT', '/api/ventas/dia/2026-10-12', { status: 'festivo', dia: { tarjeta: { importe: 99 } } });
    assert.equal(festivo.data.status, 'festivo');
    assert.equal(festivo.data.totals.tarde.cents, 0);
    const bad = await admin('PUT', '/api/ventas/dia/2026-10-21', { manana: { tarjeta: { importe: 100 } }, dia: { tarjeta: { importe: 50 } } });
    assert.equal(bad.code, 'DAY_BELOW_MORNING');
  });

  test('las estadísticas usan la caja diaria: clientes como tickets y sin franjas horarias', async () => {
    const stats = await admin('GET', '/api/estadisticas?periodo=anio');
    const oct = stats.data.monthly.find((m) => m.month === '2026-10');
    assert.equal(oct.salesCents, 55050, 'sin los vales');
    assert.equal(oct.tickets, 11);
    assert.equal(stats.data.shifts.manana.cents, 25050);
    assert.equal(stats.data.shifts.tarde.cents, 30000);
    assert.equal(stats.data.hours.rows.length, 0);
    assert.equal(stats.data.hours.fromDailyTotals, true);
    assert.equal(stats.data.hasRealSales, true);
  });

  test('importar la exportación de la app antigua: idempotente, con erratas y sin pagos a proveedores', async () => {
    const zip = new JSZip();
    const dias = [
      { fecha: '2026-08-19', id_origen: 90, manana: { importes: { tarjeta: 100 }, clientes: { tarjeta: 2 } }, tarde: { importes: { efectivo: 58.42 }, clientes: { efectivo: 30 } }, trabajado: true, festivo: false },
      { fecha: '2026-08-15', id_origen: 91, manana: {}, tarde: {}, trabajado: false, festivo: true },
      // Ya apuntado a mano: no se pisa.
      { fecha: '2026-10-20', id_origen: 92, manana: { importes: { tarjeta: 1 } }, tarde: {}, trabajado: true },
    ];
    zip.file('ventas_puntapie.json', JSON.stringify({
      totales: { total: 158.42 + 1 },
      dias,
      gastos: [
        { fecha: '2026-08-19', concepto: 'Transsarrio', importe: 109.69, id_origen: 33 },
        { fecha: '2026-08-20', concepto: 'Pago Proveedor - Lejan', importe: 593, id_origen: 13 },
      ],
    }));
    zip.file('incidencias.csv', 'fecha,incidencia\n2026-08-19,"tarde/efectivo: 30 clientes para 58,42 € (probable error de tecleo, ¿3?)"\n');
    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const upload = (who) => who.raw('POST', '/api/ventas/importar', { body, headers: { 'Content-Type': 'application/zip' } });

    const first = (await (await upload(admin)).json()).data;
    assert.equal(first.dias, 2);
    assert.equal(first.yaEstaban, 1);
    assert.deepEqual(first.erratas, ['19/08/2026 tarde efectivo: 30 → 3 clientes']);
    assert.equal(first.gastos, 1);
    assert.equal(first.gastosOmitidos.length, 1);
    const day = (await admin('GET', '/api/ventas/dia/2026-08-19')).data;
    assert.equal(day.tarde.efectivo.customers, 3);
    assert.equal((await admin('GET', '/api/ventas/dia/2026-10-20')).data.manana.tarjeta.cents, 20000, 'lo apuntado a mano se respeta');
    const ago = (await admin('GET', '/api/gastos?mes=2026-08')).data.items;
    assert.deepEqual(ago.map((i) => [i.name, i.category]), [['Transsarrio', 'esporadico']]);

    const again = (await (await upload(admin)).json()).data;
    assert.equal(again.dias, 0);
    assert.equal(again.gastosYaEstaban, 1);
  });

  test('el Empleado apunta la caja; el Asesor solo la ve; importar es del Administrador', async () => {
    const elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    assert.equal((await elena('PUT', '/api/ventas/dia/2026-10-22', { dia: { tarjeta: { importe: 10 } } })).status, 200);
    assert.equal((await elena.raw('POST', '/api/ventas/importar', { body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' } })).status, 403);

    const users = (await admin('GET', '/api/admin/users')).data;
    await admin('PATCH', `/api/admin/users/${users.find((u) => u.username === 'rperez').id}`, { role: 'asesor' });
    const asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal((await asesor('GET', '/api/ventas/dia/2026-10-22')).status, 200);
    assert.equal((await asesor('PUT', '/api/ventas/dia/2026-10-22', {})).status, 403);
  });
});
