import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImporteEs, parseImporteEn, parseFecha, matchAll } from '../src/proveedores/parsers/utils.js';

test('parseImporteEs convierte formato español a céntimos', () => {
  assert.equal(parseImporteEs('1.271,84'), 127184);
  assert.equal(parseImporteEs('577,60'), 57760);
  assert.equal(parseImporteEs(' 3.815,90 '), 381590);
  assert.equal(parseImporteEs('-12,50'), -1250);
  assert.equal(parseImporteEs('1,845.00'), null);
  assert.equal(parseImporteEs('abc'), null);
  assert.equal(parseImporteEs(undefined), null);
});

test('parseImporteEn convierte formato inglés a céntimos', () => {
  assert.equal(parseImporteEn('1,845.00'), 184500);
  assert.equal(parseImporteEn('534.50'), 53450);
  assert.equal(parseImporteEn('1.271,84'), null);
});

test('parseFecha entiende dd/mm/yyyy, dd/mm/yy, inglés largo y español largo', () => {
  assert.equal(parseFecha('02/09/2026'), '2026-09-02');
  assert.equal(parseFecha('16/10/25'), '2025-10-16');
  assert.equal(parseFecha('Fecha: September 30, 2026'), '2026-09-30');
  assert.equal(parseFecha('21 de agosto de 2026'), '2026-08-21');
  assert.equal(parseFecha('2026-09-19'), '2026-09-19');
  assert.equal(parseFecha('32/13/2026'), null);
  assert.equal(parseFecha('sin fecha'), null);
});

test('matchAll devuelve capturas únicas de todas las líneas', () => {
  const lines = [{ text: 'ALBARÁN 111' }, { text: 'x' }, { text: 'ALBARÁN 222 ALBARÁN 111' }];
  assert.deepEqual(matchAll(lines, /ALBAR[ÁA]N\s+(\d+)/), ['111', '222']);
});
