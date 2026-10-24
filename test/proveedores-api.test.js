import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { fixtureBytes, HAY_FIXTURES } from './proveedores-fixtures.js';
import { limpiarPdf } from '../src/proveedores/importar-zip.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const pdfHeaders = (name) => ({ 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(name) });

const FACTURA = Object.freeze({
  tipo: 'factura',
  proveedor: { nombre: 'Lejan Calzados', cif: 'B12345678' },
  numero: 'F0000001',
  fecha: '2026-10-01',
  total_cent: 60000,
  pedidos: ['P-77'],
  vencimientos: [{ fecha: '2026-10-10', importe_cent: 30000 }, { fecha: '2099-11-10', importe_cent: 30000 }],
});

test('limpia los PDF guardados con cabecera HTTP o sobre MIME', () => {
  const wrapped = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n'), PDF, Buffer.from('\r\n--uuid--')]);
  const { data, reparado } = limpiarPdf(wrapped);
  assert.equal(reparado, true);
  assert.equal(data.subarray(0, 5).toString(), '%PDF-');
  assert.match(data.toString(), /%%EOF$/);
  assert.equal(limpiarPdf(PDF).reparado, false);
});

describe('API de pagos a proveedores', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let facturaId;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('alta manual de factura y pedido; el pedido queda «facturado» por referencia', async () => {
    const pedido = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Lejan', cif: 'B12345678' }, numero: 'P-77', fecha: '2026-09-01', total_cent: 61000,
    });
    assert.equal(pedido.status, 201);
    assert.equal(pedido.data.estado, 'pendiente');
    const factura = await admin('POST', '/api/proveedores/documentos', FACTURA);
    assert.equal(factura.status, 201);
    facturaId = factura.data.id;
    assert.equal(factura.data.proveedor.id, pedido.data.proveedor.id, 'mismo proveedor por CIF');
    assert.equal(factura.data.estado, 'vencida', 'el primer vencimiento ya pasó');
    assert.deepEqual(factura.data.pedidos_asociados.map((p) => p.numero), ['P-77']);
    const ped = await admin('GET', `/api/proveedores/documentos/${pedido.data.id}`);
    assert.equal(ped.data.estado, 'facturado');
  });

  test('por la API no se pueden colar pagos al dar de alta', async () => {
    const res = await admin('POST', '/api/proveedores/documentos', {
      ...FACTURA, numero: 'X-1', vencimientos: [{ fecha: '2026-10-10', importe_cent: 60000, pago: { fecha: '2026-10-10', importe_cent: 60000, archivo: 1 } }],
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.estado, 'vencida', 'el pago enviado se ignora');
    await admin('DELETE', `/api/proveedores/documentos/${res.data.id}`);
    assert.equal((await admin('POST', `/api/proveedores/documentos/${facturaId}/pagar`, { fecha: '2026-02-30' })).code, 'INVALID_DATE');
  });

  test('no deja repetir número del mismo proveedor', async () => {
    const dup = await admin('POST', '/api/proveedores/documentos', FACTURA);
    assert.equal(dup.status, 409);
    assert.equal(dup.code, 'DUPLICADO');
  });

  test('pagar un vencimiento con justificante, anular el pago y pagar toda la factura', async () => {
    const doc = (await admin('GET', `/api/proveedores/documentos/${facturaId}`)).data;
    const pay = await admin.raw('POST', `/api/proveedores/documentos/${facturaId}/pagar?vencimiento_id=${doc.vencimientos[0].id}&fecha=2026-10-09&notas=Transferencia`, {
      body: PDF, headers: pdfHeaders('justificante octubre.pdf'),
    });
    assert.equal(pay.status, 201);
    const parcial = (await pay.json()).data;
    assert.equal(parcial.estado, 'parcial');
    assert.equal(parcial.pagado_cent, 30000);
    const pago = parcial.vencimientos[0].pago;
    assert.equal(pago.archivo_nombre, 'justificante octubre.pdf');
    const file = await admin.raw('GET', `/api/proveedores/pagos/${pago.id}/archivo`);
    assert.equal(file.headers.get('content-type'), 'application/pdf');

    const undo = await admin('DELETE', `/api/proveedores/pagos/${pago.id}`);
    assert.equal(undo.data.pagado_cent, 0);

    const all = await admin('POST', `/api/proveedores/documentos/${facturaId}/pagar`, { fecha: '2026-10-20' });
    assert.equal(all.status, 201);
    assert.equal(all.data.estado, 'pagada');
    assert.equal((await admin('POST', `/api/proveedores/documentos/${facturaId}/pagar`, {})).code, 'NOTHING_TO_PAY');
    // Justificante para toda la factura: va a los dos pagos.
    const just = await admin.raw('POST', `/api/proveedores/documentos/${facturaId}/justificante`, { body: PDF, headers: pdfHeaders('banco.pdf') });
    const conJust = (await just.json()).data;
    assert.ok(conJust.vencimientos.every((v) => v.pago.archivo_nombre === 'banco.pdf'));
  });

  test('editar vencimientos conserva los pagos que no cambian y no borra uno pagado sin avisar', async () => {
    const cambio = { vencimientos: [{ fecha: '2026-10-10', importe_cent: 30000 }, { fecha: '2099-12-10', importe_cent: 30000 }] };
    const blocked = await admin('PUT', `/api/proveedores/documentos/${facturaId}`, cambio);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.code, 'PAID_DUE_CHANGED');
    const doc = (await admin('GET', `/api/proveedores/documentos/${facturaId}`)).data;
    await admin('DELETE', `/api/proveedores/pagos/${doc.vencimientos[1].pago.id}`);
    const res = await admin('PUT', `/api/proveedores/documentos/${facturaId}`, cambio);
    assert.equal(res.status, 200);
    assert.ok(res.data.vencimientos[0].pago, 'mismo día e importe: sigue pagado');
    assert.equal(res.data.vencimientos[1].pago, null, 'otro día: pendiente');
    assert.equal(res.data.estado, 'parcial');
  });

  test('previsión, resumen, proveedores, calendario en PDF y CSV', async () => {
    const prevision = await admin('GET', '/api/proveedores/prevision?meses=3');
    assert.equal(prevision.data.posteriores.total_cent, 30000);
    const resumen = await admin('GET', '/api/proveedores/resumen');
    assert.equal(resumen.data.facturas, 1);
    assert.equal(resumen.data.pendiente_cent, 30000);
    const lista = await admin('GET', '/api/proveedores/lista');
    assert.equal(lista.data[0].pendiente_cent, 30000);
    const renamed = await admin('PUT', `/api/proveedores/lista/${lista.data[0].id}`, { nombre: 'LEJAN, S.L.' });
    assert.equal(renamed.data.nombre, 'LEJAN, S.L.');
    const pdf = await admin.raw('GET', '/api/proveedores/calendario.pdf?meses=3');
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const csv = await admin.raw('GET', '/api/proveedores/export.csv?tipo=factura');
    assert.match(await csv.text(), /F0000001/);
  });

  test('Importar PDF: lector del proveedor, confirmación y aviso de duplicado', { skip: !HAY_FIXTURES && 'sin PDFs reales' }, async () => {
    const bytes = fixtureBytes('Garvalin/2613709 (2).pdf');
    const analizar = () => admin.raw('POST', '/api/proveedores/analizar', { body: bytes, headers: pdfHeaders('2613709.pdf') });
    const first = (await (await analizar()).json()).data;
    assert.equal(first.extraido.parser, 'garvalin');
    assert.ok(first.extraido.total_cent > 0);
    assert.equal(first.duplicado, null);
    // Un alta que falla (fecha mal escrita) no pierde el PDF analizado: se corrige y se reintenta.
    const wrong = await admin('POST', '/api/proveedores/documentos', { tempId: first.tempId, ...first.extraido, fecha: '2026-13-01' });
    assert.equal(wrong.status, 400);
    const saved = await admin('POST', '/api/proveedores/documentos', {
      tempId: first.tempId, ...first.extraido, vencimientos: first.extraido.vencimientos,
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.archivo_nombre, '2613709.pdf');
    const second = (await (await analizar()).json()).data;
    assert.equal(second.duplicado.motivo, 'archivo');
    await admin('DELETE', `/api/proveedores/analizar/${second.tempId}`);
  });

  test('importar el ZIP de la app antigua: idempotente y solo el Administrador', async () => {
    const zip = new JSZip();
    zip.file('datos/datos.json', JSON.stringify({
      hoy: '2026-10-24',
      proveedores: [{ id: 9, nombre: 'ASESORÍA DE PRUEBA', cif: 'B00000001' }],
      documentos: [{
        id: 34, tipo: 'factura', proveedor_id: 9, proveedor: { id: 9, nombre: 'ASESORÍA DE PRUEBA', cif: 'B00000001' },
        numero: '1/2738', fecha: '2026-09-30', total_cent: 23540, pedidos: [], albaranes: [],
        archivo_nombre: 'fra.PDF', archivo_hash: 'abc', pdf: 'archivos/documentos/x-fra.PDF',
        vencimientos: [{ id: 59, fecha: '2026-10-10', importe_cent: 23540, pago: {
          id: 44, fecha: '2026-10-10', importe_cent: 23540, archivo_nombre: 'pago.pdf', justificante: 'archivos/justificantes/y-pago.pdf',
        } }],
      }],
    }));
    zip.file('archivos/documentos/x-fra.PDF', PDF);
    zip.file('archivos/justificantes/y-pago.pdf', Buffer.concat([Buffer.from('\r\n--uuid:1\r\nContent-Type: application/pdf\r\n\r\n'), PDF]));
    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const upload = (who) => who.raw('POST', '/api/proveedores/importar-zip', { body, headers: { 'Content-Type': 'application/zip', 'X-File-Name': 'copia.zip' } });

    const first = (await (await upload(admin)).json()).data;
    assert.equal(first.facturas, 1);
    assert.equal(first.pagos, 1);
    assert.deepEqual(first.reparados, ['pago.pdf']);
    const again = (await (await upload(admin)).json()).data;
    assert.equal(again.facturas, 0);
    assert.equal(again.yaEstaban, 1);

    const docs = await admin('GET', '/api/proveedores/documentos?q=2738');
    assert.equal(docs.data[0].estado, 'pagada');

    const elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    assert.equal((await upload(elena)).status, 403);
    // El Empleado sí trabaja con facturas y pagos, como en Gastos.
    assert.equal((await elena('GET', '/api/proveedores/resumen')).status, 200);
  });

  test('borrar una factura borra sus pagos y queda en el log', async () => {
    const del = await admin('DELETE', `/api/proveedores/documentos/${facturaId}`);
    assert.equal(del.status, 200);
    assert.equal((await admin('GET', `/api/proveedores/documentos/${facturaId}`)).status, 404);
    const log = await admin('GET', '/api/admin/log?area=proveedores');
    const actions = log.data.items.map((i) => i.action);
    for (const a of ['crear', 'pagar', 'anular_pago', 'borrar', 'importar']) assert.ok(actions.includes(a), a);
  });
});
