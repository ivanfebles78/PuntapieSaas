import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { entitledDays, todayInShop, vacationBalance } from '../src/services/vacation-balance.js';

describe('días de vacaciones que corresponden', () => {
  test('año completo si el contrato empezó antes del año o no consta', () => {
    assert.equal(entitledDays('2020-03-01', 2026).days, 30);
    assert.equal(entitledDays('2026-01-01', 2026).days, 30);
    assert.equal(entitledDays(null, 2026).days, 30);
  });

  test('inicio el 7 de julio → 15 días (14,6 redondeado al alza)', () => {
    const result = entitledDays('2026-07-07', 2026);
    assert.equal(result.workedDays, 178);
    assert.ok(result.exact > 14.5 && result.exact < 15);
    assert.equal(result.days, 15);
    assert.equal(result.prorated, true);
  });

  test('prorrateos en los extremos del año y en bisiestos', () => {
    assert.equal(entitledDays('2026-12-31', 2026).days, 1); // 1 día → 0,08 → 1
    assert.equal(entitledDays('2026-07-02', 2026).days, 16); // 183/365 → 15,04 → 16
    assert.equal(entitledDays('2028-07-07', 2028).days, 15); // bisiesto: 178/366 → 14,59 → 15
  });

  test('contrato que empieza el año siguiente: 0 días este año', () => {
    assert.equal(entitledDays('2027-02-01', 2026).days, 0);
  });
});

describe('saldo del año', () => {
  const periods = [
    { start: '2025-12-29', end: '2026-01-04' }, // cruza de año: 4 días en 2026
    { start: '2026-08-03', end: '2026-08-16' }, // 14 días, parte antes y parte después de hoy
    { start: '2026-12-21', end: '2026-12-24' }, // 4 días programados
  ];

  test('separa disfrutados (hasta hoy) y programados, y calcula lo que queda', () => {
    const balance = vacationBalance({ contractStart: '2019-05-01', periods, today: '2026-08-10' });
    assert.equal(balance.year, 2026);
    assert.equal(balance.entitled, 30);
    assert.equal(balance.taken, 4 + 8); // 1-4 ene + 3-10 ago
    assert.equal(balance.planned, 6 + 4); // 11-16 ago + 21-24 dic
    assert.equal(balance.remaining, 30 - 12 - 10);
  });

  test('con contrato iniciado en el año, el saldo parte de los días prorrateados', () => {
    const balance = vacationBalance({
      contractStart: '2026-07-07',
      periods: [{ start: '2026-08-03', end: '2026-08-09' }],
      today: '2026-10-22',
    });
    assert.equal(balance.entitled, 15);
    assert.equal(balance.taken, 7);
    assert.equal(balance.planned, 0);
    assert.equal(balance.remaining, 8);
  });

  test('si se pasa, lo que queda sale en negativo', () => {
    const balance = vacationBalance({
      contractStart: '2026-12-01',
      periods: [{ start: '2026-12-01', end: '2026-12-10' }],
      today: '2026-12-15',
    });
    assert.equal(balance.entitled, 3);
    assert.equal(balance.remaining, -7);
  });

  test('la fecha de hoy se toma en hora de Canarias', () => {
    assert.equal(todayInShop(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
    assert.equal(todayInShop(new Date('2026-07-01T23:30:00Z')), '2026-07-02');
  });
});

describe('los días no usados se pierden', () => {
  test('cada año empieza de cero aunque el anterior sobraran días', () => {
    const balance = vacationBalance({
      contractStart: '2020-01-15',
      periods: [{ start: '2026-08-03', end: '2026-08-07' }], // solo 5 días en 2026
      today: '2027-02-01',
    });
    assert.equal(balance.entitled, 30);
    assert.equal(balance.remaining, 30);
    assert.equal('carryOver' in balance, false);
  });
});
