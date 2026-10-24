import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calcularEstado, importePendiente, hoyIso } from '../src/proveedores/domain/estado.js';
import { calcularPrevision, sumarMeses, etiquetaMes } from '../src/proveedores/domain/prevision.js';

const HOY = '2026-09-19';
const factura = { tipo: 'factura' };
const v = (fecha, pago = null, importe_cent = 100) => ({ fecha, importe_cent, pago });

describe('calcularEstado', () => {
  test('factura sin pagos y sin vencer es pendiente', () => {
    assert.equal(calcularEstado(factura, [v('2026-10-01')], { hoy: HOY }), 'pendiente');
  });
  test('factura con un vencimiento pasado sin pagar es vencida', () => {
    assert.equal(calcularEstado(factura, [v('2026-09-01'), v('2026-10-01')], { hoy: HOY }), 'vencida');
  });
  test('vencimiento que vence hoy no cuenta como vencido', () => {
    assert.equal(calcularEstado(factura, [v(HOY)], { hoy: HOY }), 'pendiente');
  });
  test('factura con parte pagada es parcial', () => {
    assert.equal(calcularEstado(factura, [v('2026-09-01', { id: 1 }), v('2026-10-01')], { hoy: HOY }), 'parcial');
  });
  test('parcial con otro vencido pasa a vencida', () => {
    assert.equal(calcularEstado(factura, [v('2026-08-01', { id: 1 }), v('2026-09-01')], { hoy: HOY }), 'vencida');
  });
  test('todos pagados es pagada', () => {
    assert.equal(calcularEstado(factura, [v('2026-08-01', { id: 1 }), v('2026-09-01', { id: 2 })], { hoy: HOY }), 'pagada');
  });
  test('factura sin vencimientos queda pendiente', () => {
    assert.equal(calcularEstado(factura, [], { hoy: HOY }), 'pendiente');
  });
  test('pedido: manual > facturado > pendiente', () => {
    assert.equal(calcularEstado({ tipo: 'pedido', estado_manual: 'recibido' }, [], { hoy: HOY, facturado: true }), 'recibido');
    assert.equal(calcularEstado({ tipo: 'pedido', estado_manual: 'cancelado' }, [], { hoy: HOY }), 'cancelado');
    assert.equal(calcularEstado({ tipo: 'pedido' }, [], { hoy: HOY, facturado: true }), 'facturado');
    assert.equal(calcularEstado({ tipo: 'pedido' }, [], { hoy: HOY }), 'pendiente');
  });
  test('importePendiente suma solo lo no pagado', () => {
    assert.equal(importePendiente([v('x', { id: 1 }, 500), v('y', null, 250), v('z', null, 250)]), 500);
  });
  test('hoyIso formatea la fecha local', () => {
    assert.equal(hoyIso(new Date(2026, 0, 5)), '2026-01-05');
  });
});

describe('calcularPrevision', () => {
  test('sumarMeses y etiquetaMes cruzan el año', () => {
    assert.equal(sumarMeses('2026-11', 2), '2027-01');
    assert.equal(sumarMeses('2026-01', 0), '2026-01');
    assert.equal(etiquetaMes('2026-09'), 'septiembre 2026');
  });

  test('reparte en vencidos, tres meses y posteriores', () => {
    const p = calcularPrevision([
      v('2026-09-01', null, 100), // vencido
      v('2026-09-25', null, 200), // mes actual
      v('2026-10-11', null, 300), // siguiente
      v('2026-11-06', null, 400), // tercero
      v('2027-01-15', null, 500), // posterior
    ], { hoy: HOY });
    assert.equal(p.vencidos.total_cent, 100);
    assert.deepEqual(p.meses.map((m) => [m.mes, m.total_cent]), [['2026-09', 200], ['2026-10', 300], ['2026-11', 400]]);
    assert.equal(p.posteriores.total_cent, 500);
    assert.equal(p.total_pendiente_cent, 1500);
    assert.equal(p.meses[0].etiqueta, 'septiembre 2026');
  });

  test('sin pendientes devuelve ceros', () => {
    const p = calcularPrevision([], { hoy: HOY, meses: 2 });
    assert.equal(p.total_pendiente_cent, 0);
    assert.equal(p.meses.length, 2);
    assert.equal(p.vencidos.items.length, 0);
  });
});
