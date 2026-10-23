import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { computeStats, weekStart, weekday } from '../src/services/stats.js';
import { simulateSales } from '../src/services/stats-sim.js';
import { nowInShop, periodStart } from '../src/services/sales-stats.js';

const TARGETS = { dailyCents: 50000, weeklyCents: 300000, monthlyCents: 1200000 };

// Semana del lunes 5 al domingo 11 de octubre de 2026; hoy, martes 13.
const SALES = [
  { at: '2026-10-05T11:10', cents: 30000, method: 'tarjeta' }, // lunes: 600 € (cumple)
  { at: '2026-10-05T18:30', cents: 30000, method: 'efectivo' },
  { at: '2026-10-06T12:00', cents: 20000, method: 'bizum' }, // martes: 200 € (no cumple)
  { at: '2026-10-10T19:45', cents: 80000, method: 'bonos' }, // sábado: 800 € (cumple, tarde)
  { at: '2026-10-12T10:30', cents: 10000, method: 'vales' }, // lunes 12: 100 €
  { at: '2026-10-13T11:00', cents: 55000, method: 'tarjeta' }, // hoy: 550 €
];

describe('cálculo de estadísticas', () => {
  const stats = computeStats({ sales: SALES, expensesByMonth: { '2026-10': 90000 }, targets: TARGETS, from: '2026-10-01', today: '2026-10-13' });

  test('fechas: día de la semana y lunes de cada semana', () => {
    assert.equal(weekday('2026-10-05'), 1);
    assert.equal(weekday('2026-10-11'), 7);
    assert.equal(weekStart('2026-10-11'), '2026-10-05');
  });

  test('ventas de hoy, semana, mes y totales', () => {
    assert.equal(stats.kpis.today.cents, 55000);
    assert.equal(stats.kpis.week.cents, 10000 + 55000);
    assert.equal(stats.kpis.month.cents, 225000);
    assert.equal(stats.kpis.total.tickets, 6);
    assert.equal(stats.kpis.total.openDays, 5);
    assert.equal(stats.kpis.total.avgTicketCents, Math.round(225000 / 6));
  });

  test('% de días cumplidos: solo días cerrados con la tienda abierta (sin hoy)', () => {
    assert.deepEqual(stats.goals.days, { met: 2, total: 4 });
    // La semana del 5 al 11 está cerrada: 1.600 € < 3.000 €. La del 28/9 empieza antes del periodo.
    assert.deepEqual(stats.goals.weeks, { met: 0, total: 1 });
    assert.deepEqual(stats.goals.months, { met: 0, total: 0 }, 'octubre aún no ha terminado');
  });

  test('media por día de la semana: mejor y peor, contando solo días abiertos', () => {
    const monday = stats.weekdays.rows.find((r) => r.weekday === 1);
    assert.equal(monday.days, 2);
    assert.equal(monday.avgCents, Math.round((60000 + 10000) / 2));
    assert.equal(stats.weekdays.best, 6, 'sábado: 800 €');
    assert.equal(stats.weekdays.worst, 1, 'lunes: (600 + 100) / 2 = 350 €; martes: (200 + 550) / 2 = 375 €');
  });

  test('métodos de pago con su parte del total', () => {
    const tarjeta = stats.methods.find((m) => m.id === 'tarjeta');
    assert.equal(tarjeta.cents, 85000);
    assert.equal(tarjeta.count, 2);
    assert.ok(Math.abs(stats.methods.reduce((t, m) => t + m.share, 0) - 1) < 1e-9);
  });

  test('turnos: mañana antes de las 15:00 y quién gana cada día', () => {
    assert.equal(stats.shifts.manana.cents, 30000 + 20000 + 10000 + 55000);
    assert.equal(stats.shifts.tarde.cents, 30000 + 80000);
    assert.equal(stats.shifts.tarde.daysWon, 1);
    assert.equal(stats.shifts.manana.daysWon, 3, 'martes, lunes 12 y hoy; el lunes 5 empata');
  });

  test('franjas horarias: de la primera a la última hora con ventas', () => {
    assert.equal(stats.hours.rows[0].hour, 10);
    assert.equal(stats.hours.rows.at(-1).hour, 19);
    assert.equal(stats.hours.best, 11, '11:00 suma 300 + 550 €');
    assert.equal(stats.hours.worst, 10, '10:00 suma 100 €');
  });

  test('histórico mensual con gastos y beneficio', () => {
    assert.deepEqual(stats.monthly.map((m) => [m.month, m.salesCents, m.expensesCents, m.profitCents]),
      [['2026-10', 225000, 90000, 135000]]);
    assert.equal(stats.daily.length, 13);
  });
});

describe('simulación', () => {
  test('es reproducible, cierra los domingos y respeta la hora actual de hoy', () => {
    const a = simulateSales('2026-09-01', '2026-10-13', '12:00');
    const b = simulateSales('2026-09-01', '2026-10-13', '12:00');
    assert.deepEqual(a, b);
    assert.ok(a.length > 200);
    assert.ok(a.every((s) => weekday(s.at.slice(0, 10)) !== 7));
    assert.ok(a.filter((s) => s.at.startsWith('2026-10-13')).every((s) => s.at.slice(11) <= '12:00'));
  });

  test('periodos y hora de la tienda', () => {
    assert.equal(periodStart('3m', '2026-10-23'), '2026-08-01');
    assert.equal(periodStart('12m', '2026-10-23'), '2025-11-01');
    assert.equal(periodStart('anio', '2026-10-23'), '2026-01-01');
    assert.throws(() => periodStart('5y', '2026-10-23'));
    assert.deepEqual(nowInShop(new Date('2026-07-01T23:30:00Z')), { day: '2026-07-02', time: '00:30' });
  });
});

describe('API de estadísticas', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('sin ventas reales lo indica; con simular=1 devuelve datos', async () => {
    const real = await admin('GET', '/api/estadisticas?periodo=3m');
    assert.equal(real.status, 200);
    assert.equal(real.data.hasRealSales, false);
    assert.equal(real.data.kpis.total.tickets, 0);
    const sim = await admin('GET', '/api/estadisticas?periodo=3m&simular=1');
    assert.equal(sim.data.simulated, true);
    assert.ok(sim.data.kpis.total.tickets > 100);
    assert.equal(sim.data.methods.length, 5);
  });

  test('lee las ventas reales en hora de Canarias', async () => {
    const { day } = nowInShop();
    await ctx.pool.query(
      "INSERT INTO sales (sold_at, total_cents, payment_method) VALUES (($1 || ' 10:30')::timestamp AT TIME ZONE 'Atlantic/Canary', 4590, 'tarjeta')",
      [day],
    );
    const res = await admin('GET', '/api/estadisticas?periodo=3m');
    assert.equal(res.data.hasRealSales, true);
    assert.equal(res.data.kpis.today.cents, 4590);
    assert.equal(res.data.hours.rows[0].hour, 10);
  });

  test('objetivos: por defecto 500/3.000/12.000 €, los cambia solo el Administrador', async () => {
    const current = await admin('GET', '/api/estadisticas/objetivos');
    assert.deepEqual(current.data, TARGETS);
    const saved = await admin('PUT', '/api/estadisticas/objetivos', { daily: '550', weekly: '3.300', monthly: '13.000' });
    assert.deepEqual(saved.data, { dailyCents: 55000, weeklyCents: 330000, monthlyCents: 1300000 });
    const stats = await admin('GET', '/api/estadisticas?periodo=3m');
    assert.equal(stats.data.targets.dailyCents, 55000);
    assert.equal((await admin('PUT', '/api/estadisticas/objetivos', { daily: 0, weekly: 1, monthly: 1 })).status, 400);

    const elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    assert.equal((await elena('GET', '/api/estadisticas?periodo=3m')).status, 200);
    assert.equal((await elena('PUT', '/api/estadisticas/objetivos', { daily: 1, weekly: 1, monthly: 1 })).status, 403);
  });

  test('periodo no válido', async () => {
    assert.equal((await admin('GET', '/api/estadisticas?periodo=5y')).status, 400);
  });
});
