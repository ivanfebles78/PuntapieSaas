import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { computeStats, targetsForMonth, weekStart, weekday } from '../src/services/stats.js';
import { simulateSales } from '../src/services/stats-sim.js';
import { nowInShop, periodStart, statsStart } from '../src/services/sales-stats.js';

const TARGETS = { dailyCents: 50000, weeklyCents: 300000, monthlyCents: 1200000 };

// Semana del lunes 5 al domingo 11 de octubre de 2026; hoy, martes 13.
const SALES = [
  { at: '2026-10-05T11:10', cents: 30000, method: 'tarjeta' }, // lunes: 600 € (cumple)
  { at: '2026-10-05T18:30', cents: 30000, method: 'efectivo' },
  { at: '2026-10-06T12:00', cents: 20000, method: 'bizum' }, // martes: 200 € (no cumple)
  { at: '2026-10-10T19:45', cents: 80000, method: 'bonos' }, // sábado: 800 € (cumple, tarde)
  { at: '2026-10-12T10:30', cents: 10000, method: 'vales' }, // lunes 12: 100 € en vales (no suma)
  { at: '2026-10-13T11:00', cents: 55000, method: 'tarjeta' }, // hoy: 550 €
];

test('cada mes usa sus propios objetivos; los meses sin ellos, los de por defecto', () => {
  const julio = { dailyCents: 25000, weeklyCents: 150000, monthlyCents: 600000 };
  const targets = { ...TARGETS, byMonth: { '2026-07': julio } };
  assert.deepEqual(targetsForMonth(targets, '2026-07'), julio);
  assert.deepEqual(targetsForMonth(targets, '2027-07'), TARGETS, 'otro año: los de por defecto');

  // Octubre con sus objetivos (250 €/día): el día de 200 € no cumple, el de 600 € sí.
  const s = computeStats({ sales: SALES, targets: { ...TARGETS, byMonth: { '2026-10': julio } }, from: '2026-10-01', today: '2026-10-13' });
  assert.equal(s.kpis.today.targetCents, 25000);
  assert.equal(s.kpis.month.targetCents, 600000);
  assert.equal(s.currentTargets.weeklyCents, 150000);
  assert.equal(s.monthly[0].targetCents, 600000);
  assert.deepEqual(s.daily.find((d) => d.day === '2026-10-06'), { day: '2026-10-06', cents: 20000, tickets: 1, targetCents: 25000 });
  assert.deepEqual(s.goals.days, { met: 2, total: 3 });
});

describe('cálculo de estadísticas', () => {
  const stats = computeStats({ sales: SALES, expensesByMonth: { '2026-10': 90000 }, targets: TARGETS, from: '2026-10-01', today: '2026-10-13' });

  test('fechas: día de la semana y lunes de cada semana', () => {
    assert.equal(weekday('2026-10-05'), 1);
    assert.equal(weekday('2026-10-11'), 7);
    assert.equal(weekStart('2026-10-11'), '2026-10-05');
  });

  test('ventas de hoy, semana, mes y totales', () => {
    assert.equal(stats.kpis.today.cents, 55000);
    assert.equal(stats.kpis.week.cents, 55000, 'los vales del lunes 12 no suman');
    assert.equal(stats.kpis.month.cents, 215000);
    assert.equal(stats.kpis.total.tickets, 5);
    assert.equal(stats.kpis.total.openDays, 4);
    assert.equal(stats.kpis.total.avgTicketCents, Math.round(215000 / 5));
    assert.deepEqual(stats.kpis.vouchers, { cents: 10000, count: 1 }, 'los vales se cuentan aparte');
  });

  test('% de días cumplidos: solo días cerrados con la tienda abierta (sin hoy)', () => {
    assert.deepEqual(stats.goals.days, { met: 2, total: 3 });
    // La semana del 5 al 11 está cerrada: 1.600 € < 3.000 €. La del 28/9 empieza antes del periodo.
    assert.deepEqual(stats.goals.weeks, { met: 0, total: 1 });
    assert.deepEqual(stats.goals.months, { met: 0, total: 0 }, 'octubre aún no ha terminado');
  });

  test('media por día de la semana: mejor y peor, contando solo días abiertos', () => {
    const monday = stats.weekdays.rows.find((r) => r.weekday === 1);
    assert.equal(monday.days, 1, 'el lunes 12 solo tuvo vales');
    assert.equal(monday.avgCents, 60000);
    assert.equal(stats.weekdays.best, 6, 'sábado: 800 €');
    assert.equal(stats.weekdays.worst, 2, 'martes: (200 + 550) / 2 = 375 €');
  });

  test('métodos de pago con su parte del total', () => {
    const tarjeta = stats.methods.find((m) => m.id === 'tarjeta');
    assert.equal(tarjeta.cents, 85000);
    assert.equal(tarjeta.count, 2);
    assert.ok(Math.abs(stats.methods.reduce((t, m) => t + m.share, 0) - 1) < 1e-9);
    const vales = stats.methods.find((m) => m.id === 'vales');
    assert.equal(vales.cents, 10000);
    assert.equal(vales.revenue, false);
    assert.equal(vales.share, 0);
  });

  test('turnos: mañana antes de las 15:00 y quién gana cada día', () => {
    assert.equal(stats.shifts.manana.cents, 30000 + 20000 + 55000);
    assert.equal(stats.shifts.tarde.cents, 30000 + 80000);
    assert.equal(stats.shifts.tarde.daysWon, 1);
    assert.equal(stats.shifts.manana.daysWon, 2, 'martes y hoy; el lunes 5 empata');
  });

  test('franjas horarias: de la primera a la última hora con ventas', () => {
    assert.equal(stats.hours.rows[0].hour, 11, 'a las 10 solo hubo vales');
    assert.equal(stats.hours.rows.at(-1).hour, 19);
    assert.equal(stats.hours.best, 11, '11:00 suma 300 + 550 €');
    assert.equal(stats.hours.worst, 12, '12:00 suma 200 €');
  });

  test('histórico mensual con gastos y beneficio', () => {
    assert.deepEqual(stats.monthly.map((m) => [m.month, m.salesCents, m.expensesCents, m.profitCents]),
      [['2026-10', 215000, 90000, 125000]]);
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
    // Nada antes del 16/04/2026: era del dueño anterior.
    assert.equal(statsStart('anio', '2026-10-23', '2026-04-16'), '2026-04-16');
    assert.equal(statsStart('3m', '2026-10-23', '2026-04-16'), '2026-08-01');
    assert.equal(statsStart('12m', '2027-10-23', '2026-04-16'), '2026-11-01');
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
    assert.deepEqual(current.data, { ...TARGETS, byMonth: {} });
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

  test('objetivos de un mes concreto: cambiar agosto 2027 no toca los demás meses', async () => {
    const ago26 = await admin('PUT', '/api/estadisticas/objetivos/mes/2026-08', { daily: '400', weekly: '2.400', monthly: '9.600' });
    assert.equal(ago26.status, 200, ago26.error);
    const ago27 = await admin('PUT', '/api/estadisticas/objetivos/mes/2027-08', { daily: '625', weekly: '3.750', monthly: '15.000' });
    assert.deepEqual(ago27.data.byMonth, {
      '2026-08': { dailyCents: 40000, weeklyCents: 240000, monthlyCents: 960000 },
      '2027-08': { dailyCents: 62500, weeklyCents: 375000, monthlyCents: 1500000 },
    });
    // Cambiar agosto 2027 otra vez: agosto 2026 sigue igual.
    const otraVez = await admin('PUT', '/api/estadisticas/objetivos/mes/2027-08', { daily: '500', weekly: '3.000', monthly: '12.000' });
    assert.deepEqual(otraVez.data.byMonth['2026-08'], { dailyCents: 40000, weeklyCents: 240000, monthlyCents: 960000 });
    // Cambiar los de por defecto no toca los de cada mes.
    await admin('PUT', '/api/estadisticas/objetivos', { daily: '550', weekly: '3.300', monthly: '13.200' });
    assert.deepEqual((await admin('GET', '/api/estadisticas/objetivos')).data.byMonth, otraVez.data.byMonth);
    // Quitar los de un mes: vuelve a los de por defecto.
    const quitado = await admin('DELETE', '/api/estadisticas/objetivos/mes/2027-08');
    assert.deepEqual(Object.keys(quitado.data.byMonth), ['2026-08']);

    assert.equal((await admin('PUT', '/api/estadisticas/objetivos/mes/2027-13', { daily: 1, weekly: 1, monthly: 1 })).status, 400);
    assert.equal((await admin('PUT', '/api/estadisticas/objetivos/mes/2027-03', { daily: '-5', weekly: 1, monthly: 1 })).status, 400);
    const log = await ctx.pool.query("SELECT field, old_value, new_value FROM audit_log WHERE target = 'Objetivos de agosto 2027' ORDER BY id");
    // Al quitarlos, el log apunta los tres: de su valor a «general».
    const quitar = log.rows.slice(-3);
    assert.deepEqual(quitar.map((r) => r.field), ['Objetivo diario', 'Objetivo semanal', 'Objetivo mensual']);
    assert.match(quitar[0].old_value, /^500,00\s€$/);
    assert.ok(quitar.every((r) => r.new_value === 'general'));
  });

  test('objetivos guardados antes solo con el mensual: se leen con su diario y semanal', async () => {
    await ctx.pool.query("UPDATE settings SET value = value || '{\"2026-11\": 600000}'::jsonb WHERE key = 'sales_targets_by_month'");
    const byMonth = (await admin('GET', '/api/estadisticas/objetivos')).data.byMonth;
    assert.deepEqual(byMonth['2026-11'], { dailyCents: 25000, weeklyCents: 150000, monthlyCents: 600000 });
  });

  test('periodo no válido', async () => {
    assert.equal((await admin('GET', '/api/estadisticas?periodo=5y')).status, 400);
  });
});
