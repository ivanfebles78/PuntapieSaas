import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordenarFacturas } from '../public/proveedores/orden.js';

const doc = (id, proximo, vtos = [], fecha = '2026-01-01') => ({ id, proximo_vencimiento: proximo, vencimientos: vtos.map((f) => ({ fecha: f })), fecha });

test('por defecto ordena por vencimiento: el más cercano arriba, el más lejano abajo y las pagadas al final', () => {
  const docs = [
    doc(1, '2026-12-01'),
    doc(2, null, ['2026-09-01']),
    doc(3, '2026-10-20'), // ya vencida: lo más urgente
    doc(4, '2026-11-05'),
    doc(5, null, ['2026-10-01']),
  ];
  assert.deepEqual(ordenarFacturas(docs).map((d) => d.id), [3, 4, 1, 2, 5]);
  assert.deepEqual(docs.map((d) => d.id), [1, 2, 3, 4, 5], 'no muta la lista original');
});

test('«fecha» deja el orden del servidor', () => {
  const docs = [doc(1, '2026-12-01'), doc(2, '2026-10-01')];
  assert.equal(ordenarFacturas(docs, 'fecha'), docs);
});
