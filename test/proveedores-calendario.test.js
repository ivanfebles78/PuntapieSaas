import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { construirCalendario, diasDelMes, diaSemana, DIAS_SEMANA } from '../src/proveedores/domain/calendario.js';

const HOY = '2026-10-14';
const v = (fecha, importe_cent, extra = {}) => ({ fecha, importe_cent, proveedor_nombre: 'PROV', numero: 'F-1', ...extra });

describe('utilidades de fechas', () => {
  test('diasDelMes cuenta bien meses de 30, 31, febrero y bisiesto', () => {
    assert.equal(diasDelMes('2026-10'), 31);
    assert.equal(diasDelMes('2026-11'), 30);
    assert.equal(diasDelMes('2026-02'), 28);
    assert.equal(diasDelMes('2028-02'), 29);
  });

  test('diaSemana usa lunes como primer día', () => {
    assert.equal(DIAS_SEMANA[diaSemana('2026-10-12')], 'Lun');
    assert.equal(DIAS_SEMANA[diaSemana('2026-10-14')], 'Mié');
    assert.equal(DIAS_SEMANA[diaSemana('2026-10-18')], 'Dom');
  });
});

describe('construirCalendario', () => {
  test('reparte los vencimientos en el día que les toca y suma por día', () => {
    const c = construirCalendario([
      v('2026-10-14', 10000), v('2026-10-14', 5000, { numero: 'F-2' }), v('2026-10-31', 20000),
    ], { hoy: HOY, meses: 3 });

    const octubre = c.calendario[0];
    assert.equal(octubre.mes, '2026-10');
    assert.equal(octubre.etiqueta, 'octubre 2026');
    assert.equal(octubre.total_cent, 35000);
    assert.equal(octubre.dias_con_pagos, 2);

    const dia14 = octubre.semanas.flat().find((d) => d?.dia === 14);
    assert.equal(dia14.items.length, 2);
    assert.equal(dia14.total_cent, 15000);
    assert.equal(dia14.esHoy, true);
    assert.equal(dia14.pasado, false);
  });

  test('la rejilla empieza en lunes, rellena huecos y cubre semanas completas', () => {
    const [octubre] = construirCalendario([], { hoy: HOY, meses: 3 }).calendario;
    assert.ok(octubre.semanas.every((s) => s.length === 7), 'todas las semanas tienen 7 celdas');
    // El 1 de octubre de 2026 es jueves: 3 huecos antes.
    assert.deepEqual(octubre.semanas[0].slice(0, 3), [null, null, null]);
    assert.equal(octubre.semanas[0][3].dia, 1);
    const dias = octubre.semanas.flat().filter(Boolean).map((d) => d.dia);
    assert.deepEqual(dias, Array.from({ length: 31 }, (_, i) => i + 1));
  });

  test('separa vencidos, periodo y posteriores; los pagados no suman', () => {
    const c = construirCalendario([
      v('2026-08-01', 1000),                       // vencido de un mes anterior
      v('2026-10-02', 2000),                       // vencido dentro del mes actual
      v('2026-10-05', 3000, { pagado: true }),     // ya pagado: no cuenta
      v('2026-10-20', 4000),                       // por pagar
      v('2026-12-31', 5000),                       // último mes del periodo (3 meses: oct, nov, dic)
      v('2027-01-15', 6000),                       // posterior
    ], { hoy: HOY, meses: 3 });

    assert.deepEqual(c.vencidos.items.map((x) => x.fecha), ['2026-08-01', '2026-10-02']);
    assert.equal(c.vencidos.total_cent, 3000);
    assert.equal(c.calendario.map((m) => m.mes).join(), '2026-10,2026-11,2026-12');
    assert.equal(c.calendario[0].pagado_cent, 3000);
    assert.equal(c.calendario[0].total_cent, 6000, 'los pendientes del mes incluyen el vencido del día 2');
    assert.deepEqual(c.posteriores.items.map((x) => x.fecha), ['2027-01-15']);
    assert.equal(c.total_pendiente_cent, 9000, 'lo que queda por pagar de hoy en adelante dentro del periodo');
    assert.equal(c.desde, '2026-10-01');
    assert.equal(c.hasta, '2026-12-31');
  });

  test('admite 3, 6 y 9 meses y cae a 3 con valores no válidos', () => {
    for (const meses of [3, 6, 9]) {
      assert.equal(construirCalendario([], { hoy: HOY, meses }).calendario.length, meses);
    }
    assert.equal(construirCalendario([], { hoy: HOY, meses: 4 }).calendario.length, 3);
    assert.equal(construirCalendario([], { hoy: HOY, meses: 'x' }).calendario.length, 3);
    // 9 meses desde octubre cruzan el año.
    assert.equal(construirCalendario([], { hoy: HOY, meses: 9 }).calendario.at(-1).mes, '2027-06');
  });

  test('ordena los vencimientos del mismo día por proveedor', () => {
    const c = construirCalendario([
      v('2026-11-10', 100, { proveedor_nombre: 'ZAPATOS' }),
      v('2026-11-10', 200, { proveedor_nombre: 'ALFA' }),
    ], { hoy: HOY, meses: 3 });
    const dia = c.calendario[1].semanas.flat().find((d) => d?.dia === 10);
    assert.deepEqual(dia.items.map((i) => i.proveedor_nombre), ['ALFA', 'ZAPATOS']);
  });
});
