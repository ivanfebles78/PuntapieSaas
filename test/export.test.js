import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { safeName } from '../src/services/exports.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function readZip(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  return JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
}

async function readSheet(zip, name, sheet) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await zip.file(name).async('nodebuffer'));
  return workbook.getWorksheet(sheet);
}

test('nombres seguros dentro del ZIP', () => {
  assert.equal(safeName('Luz: oct/nov "2026"'), 'Luz_ oct_nov _2026_');
  assert.equal(safeName('..\\..\\secreto'), '_.._secreto');
  assert.equal(safeName(''), 'archivo');
});

describe('exportar a ZIP', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('gastos: Excel con todos los movimientos y los documentos en carpetas', async () => {
    const luz = await admin('POST', '/api/gastos', { name: 'Luz', category: 'recurrente', kind: 'fijo', amount: '120,50', startMonth: '2026-09' });
    await admin('POST', '/api/gastos', { name: 'Garvalín', category: 'esporadico', amount: '1.500', date: '2026-10-05' });
    const upload = (tipo, body, mime, name) => admin.raw('POST', `/api/gastos/${luz.data.id}/archivos?mes=2026-10&tipo=${tipo}`, {
      body, headers: { 'Content-Type': mime, 'X-File-Name': encodeURIComponent(name) },
    });
    assert.equal((await upload('factura', PDF, 'application/pdf', 'Factura octubre.pdf')).status, 201);
    assert.equal((await upload('justificante', PNG, 'image/png', 'pago.png')).status, 201);

    const zip = await readZip(await admin.raw('GET', '/api/gastos/exportar?desde=2026-09&hasta=2026-10'));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    assert.ok(names.includes('gastos_2026-09_a_2026-10.xlsx'));
    assert.ok(names.includes('LEEME.txt'));
    const invoice = names.find((n) => n.startsWith('facturas/2026-10/Luz/'));
    assert.match(invoice, /Factura octubre\.pdf$/);
    assert.deepEqual(await zip.file(invoice).async('nodebuffer'), PDF);
    assert.ok(names.some((n) => n.startsWith('justificantes/2026-10/Luz/')));

    const sheet = await readSheet(zip, 'gastos_2026-09_a_2026-10.xlsx', 'Gastos');
    const rows = sheet.getSheetValues().slice(2).map((r) => [r[1], r[3], r[6], r[7]]);
    assert.deepEqual(rows, [
      ['2026-09', 'Luz', 120.5, 'Pendiente'],
      ['2026-10', 'Luz', 120.5, 'Pagado'],
      ['2026-10', 'Garvalín', 1500, 'Pendiente'],
    ]);
    // La celda de facturas enlaza al archivo dentro del ZIP.
    assert.equal(sheet.getRow(3).getCell(9).value.hyperlink, invoice);
  });

  test('gastos: «todo» desde el primer mes con gastos', async () => {
    const zip = await readZip(await admin.raw('GET', '/api/gastos/exportar?todo=1'));
    assert.ok(Object.keys(zip.files).some((n) => /^gastos_2026-09_a_\d{4}-\d{2}\.xlsx$/.test(n)));
  });

  test('ventas: Excel con cada ticket, el resumen por día y por empleado', async () => {
    const zip = await readZip(await admin.raw('GET', '/api/estadisticas/exportar?periodo=3m&simular=1'));
    const name = Object.keys(zip.files).find((n) => n.endsWith('_SIMULADO.xlsx'));
    assert.ok(name, 'el archivo avisa de que son datos simulados');
    const ventas = await readSheet(zip, name, 'Ventas');
    assert.ok(ventas.rowCount > 100);
    assert.deepEqual(ventas.getRow(1).values.slice(1), ['Fecha', 'Hora', 'Día', 'Turno', 'Importe', 'Método de pago', 'En el turno']);
    assert.ok(await readSheet(zip, name, 'Por día'));
    assert.ok(await readSheet(zip, name, 'Por empleado'));
  });

  test('las exportaciones quedan en el log', async () => {
    const log = await admin('GET', '/api/admin/log?accion=exportar');
    assert.ok(log.data.items.some((i) => i.area === 'gastos'));
    assert.ok(log.data.items.some((i) => i.area === 'ventas'));
  });
});
