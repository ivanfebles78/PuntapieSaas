import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { readCents } from '../src/services/money.js';
import { cleanFilename } from '../src/services/expense-files.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('importes y nombres de archivo', () => {
  test('lee importes en formato español', () => {
    assert.equal(readCents('1.250,50'), 125050);
    assert.equal(readCents('1250,5'), 125050);
    assert.equal(readCents('1250.5'), 125050);
    assert.equal(readCents('1.250'), 125000);
    assert.equal(readCents(89.9), 8990);
    assert.equal(readCents('0'), 0);
    assert.throws(() => readCents('-5'), /no es válido/);
    assert.throws(() => readCents('abc'), /no es válido/);
    assert.throws(() => readCents('12,345'), /no es válido/);
  });

  test('limpia los nombres de archivo', () => {
    assert.equal(cleanFilename(encodeURIComponent('Factura alquiler – octubre.pdf')), 'Factura alquiler – octubre.pdf');
    assert.equal(cleanFilename('..%2F..%2Fetc%2Fpasswd'), 'passwd');
    assert.equal(cleanFilename(''), 'documento');
  });
});

describe('gastos recurrentes', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  const ids = {};

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  const view = async (mes) => (await admin('GET', `/api/gastos?mes=${mes}`)).data;
  const item = async (mes, id) => (await view(mes)).items.find((i) => i.id === id);

  test('alta de gastos fijos y variables', async () => {
    const alquiler = await admin('POST', '/api/gastos', { name: 'Alquiler', kind: 'fijo', amount: '1.200,00', startMonth: '2026-09' });
    assert.equal(alquiler.status, 201);
    ids.alquiler = alquiler.data.id;
    ids.luz = (await admin('POST', '/api/gastos', { name: 'Luz', kind: 'variable', startMonth: '2026-09' })).data.id;
    ids.alarma = (await admin('POST', '/api/gastos', { name: 'Alarma', kind: 'fijo', amount: 45, startMonth: '2026-10' })).data.id;

    const bad = await admin('POST', '/api/gastos', { name: '', kind: 'fijo', startMonth: '2026-09' });
    assert.equal(bad.status, 400);
    const badKind = await admin('POST', '/api/gastos', { name: 'X', kind: 'otro', startMonth: '2026-09' });
    assert.equal(badKind.status, 400);
  });

  test('el fijo se propaga mes a mes y el variable empieza cada mes en 0', async () => {
    const sept = await view('2026-09');
    assert.deepEqual(sept.items.map((i) => i.name), ['Alquiler', 'Luz'], 'la alarma empieza en octubre');
    const dic = await view('2026-12');
    const alquiler = dic.items.find((i) => i.id === ids.alquiler);
    assert.equal(alquiler.amountCents, 120000);
    assert.equal(alquiler.amountSource, 'fijo');
    const luz = dic.items.find((i) => i.id === ids.luz);
    assert.equal(luz.amountCents, 0);
    assert.equal(luz.amountSource, 'vacio');
    assert.equal(dic.totals.totalCents, 120000 + 4500);
    assert.equal(dic.totals.pendingCount, 3);
  });

  test('el variable se escribe cada mes', async () => {
    await admin('PUT', `/api/gastos/${ids.luz}/importe`, { month: '2026-10', amount: '87,45' });
    assert.equal((await item('2026-10', ids.luz)).amountCents, 8745);
    assert.equal((await item('2026-11', ids.luz)).amountCents, 0);
  });

  test('un fijo puede cambiar solo un mes o desde un mes en adelante', async () => {
    await admin('PUT', `/api/gastos/${ids.alquiler}/importe`, { month: '2026-10', amount: '1.150', scope: 'mes' });
    assert.equal((await item('2026-10', ids.alquiler)).amountCents, 115000);
    assert.equal((await item('2026-10', ids.alquiler)).amountSource, 'mes');
    assert.equal((await item('2026-11', ids.alquiler)).amountCents, 120000, 'el cambio puntual no se propaga');

    await admin('PUT', `/api/gastos/${ids.alquiler}/importe`, { month: '2027-01', amount: '1.260', scope: 'desde' });
    assert.equal((await item('2026-12', ids.alquiler)).amountCents, 120000);
    assert.equal((await item('2027-01', ids.alquiler)).amountCents, 126000);
    assert.equal((await item('2027-06', ids.alquiler)).amountCents, 126000);
    assert.equal((await item('2026-10', ids.alquiler)).amountCents, 115000, 'lo puntual anterior se respeta');
  });

  test('cambiar el estado a mano', async () => {
    const res = await admin('PUT', `/api/gastos/${ids.alarma}/estado`, { month: '2026-10', status: 'pagado' });
    assert.equal(res.status, 200);
    const oct = await view('2026-10');
    assert.equal(oct.items.find((i) => i.id === ids.alarma).status, 'pagado');
    assert.equal(oct.totals.paidCents, 4500);
    assert.equal((await item('2026-11', ids.alarma)).status, 'pendiente', 'cada mes empieza pendiente');
  });

  test('subir un justificante marca el mes como pagado; borrarlo lo devuelve a pendiente', async () => {
    const factura = await admin.raw('POST', `/api/gastos/${ids.alquiler}/archivos?mes=2026-11&tipo=factura`, {
      body: PDF, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('Factura noviembre.pdf') },
    });
    assert.equal(factura.status, 201);
    let nov = await item('2026-11', ids.alquiler);
    assert.equal(nov.invoices.length, 1);
    assert.equal(nov.invoices[0].filename, 'Factura noviembre.pdf');
    assert.equal(nov.status, 'pendiente', 'una factura no marca pagado');

    const justificante = await admin.raw('POST', `/api/gastos/${ids.alquiler}/archivos?mes=2026-11&tipo=justificante`, {
      body: PNG, headers: { 'Content-Type': 'image/png', 'X-File-Name': 'transferencia.png' },
    });
    assert.equal(justificante.status, 201);
    nov = await item('2026-11', ids.alquiler);
    assert.equal(nov.status, 'pagado');
    assert.equal(nov.receipts.length, 1);

    const download = await admin.raw('GET', `/api/gastos/archivos/${nov.invoices[0].id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(download.headers.get('content-disposition'), /inline; filename=/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PDF);

    const del = await admin('DELETE', `/api/gastos/archivos/${nov.receipts[0].id}`);
    assert.equal(del.status, 200);
    assert.equal((await item('2026-11', ids.alquiler)).status, 'pendiente');
  });

  test('rechaza archivos que no son PDF ni imagen o que mienten sobre su tipo', async () => {
    const exe = await admin.raw('POST', `/api/gastos/${ids.luz}/archivos?mes=2026-10&tipo=factura`, {
      body: Buffer.from('MZ fake'), headers: { 'Content-Type': 'application/x-msdownload', 'X-File-Name': 'virus.exe' },
    });
    assert.equal(exe.status, 415);
    const fake = await admin.raw('POST', `/api/gastos/${ids.luz}/archivos?mes=2026-10&tipo=factura`, {
      body: Buffer.from('<html>hola</html>'), headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'falso.pdf' },
    });
    assert.equal(fake.status, 415);
    const big = await admin.raw('POST', `/api/gastos/${ids.luz}/archivos?mes=2026-10&tipo=factura`, {
      body: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), headers: { 'Content-Type': 'application/pdf' },
    });
    assert.equal(big.status, 413);
  });

  test('no deja tocar meses en los que el gasto no está activo', async () => {
    const res = await admin('PUT', `/api/gastos/${ids.alarma}/importe`, { month: '2026-09', amount: 10 });
    assert.equal(res.status, 409);
  });

  test('dejar de pagar un gasto desde un mes; si empezaba ese mes, se borra', async () => {
    const fin = await admin('POST', `/api/gastos/${ids.luz}/fin`, { month: '2027-02' });
    assert.equal(fin.data.deleted, false);
    assert.ok(await item('2027-01', ids.luz));
    assert.equal(await item('2027-02', ids.luz), undefined);

    const borrar = await admin('POST', `/api/gastos/${ids.alarma}/fin`, { month: '2026-10' });
    assert.equal(borrar.data.deleted, true);
    assert.equal(await item('2026-12', ids.alarma), undefined);
  });

  test('renombrar un gasto', async () => {
    await admin('PATCH', `/api/gastos/${ids.alquiler}`, { name: 'Alquiler local' });
    assert.equal((await item('2026-12', ids.alquiler)).name, 'Alquiler local');
  });

  test('pide un mes válido y sesión', async () => {
    assert.equal((await admin('GET', '/api/gastos?mes=2026-13')).status, 400);
    assert.equal((await ctx.client()('GET', '/api/gastos?mes=2026-10')).status, 401);
  });
});

describe('una sola tabla con tipos de gasto', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    await admin('POST', '/api/gastos', { category: 'recurrente', kind: 'fijo', name: 'Alquiler', amount: 1200, startMonth: '2026-09' });
    await admin('POST', '/api/gastos', { category: 'esporadico', name: 'Reparación persiana', amount: '180,50', date: '2026-10-14' });
    // Los pagos a proveedores vienen del gestor: una factura con dos vencimientos.
    const fra = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'factura', proveedor: { nombre: 'Garvalín', cif: 'B03406949' }, numero: '2613', fecha: '2026-10-05', total_cent: 234000,
      vencimientos: [{ fecha: '2026-11-05', importe_cent: 117000 }, { fecha: '2026-12-05', importe_cent: 117000 }],
    });
    assert.equal(fra.status, 201);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('los pagos únicos aparecen solo en su mes, con su fecha y su tipo', async () => {
    const oct = (await admin('GET', '/api/gastos?mes=2026-10')).data;
    assert.deepEqual(oct.items.map((i) => [i.category, i.name]), [
      ['recurrente', 'Alquiler'],
      ['esporadico', 'Reparación persiana'],
      ['proveedor', 'Garvalín · Fra. 2613'],
    ]);
    const persiana = oct.items.find((i) => i.category === 'esporadico');
    assert.equal(persiana.date, '2026-10-14');
    assert.equal(persiana.kind, 'unico');
    assert.equal(persiana.amountCents, 18050);
    const nov = (await admin('GET', '/api/gastos?mes=2026-11')).data;
    assert.deepEqual(nov.items.map((i) => i.name), ['Alquiler']);
  });

  test('el total del mes suma los tres tipos y se desglosa por tipo', async () => {
    const { totals } = (await admin('GET', '/api/gastos?mes=2026-10')).data;
    assert.equal(totals.totalCents, 120000 + 18050 + 234000);
    assert.deepEqual(totals.byCategory, { recurrente: 120000, esporadico: 18050, proveedor: 234000 });
  });

  test('varios meses a la vez, con el mes en cada fila', async () => {
    const res = await admin('GET', '/api/gastos?desde=2026-09&hasta=2026-11');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.items.map((i) => `${i.month} ${i.name}`), [
      '2026-09 Alquiler',
      '2026-10 Alquiler', '2026-10 Reparación persiana', '2026-10 Garvalín · Fra. 2613',
      '2026-11 Alquiler',
    ]);
    assert.equal(res.data.totals.byCategory.recurrente, 3 * 120000);
    const reversed = await admin('GET', '/api/gastos?desde=2026-11&hasta=2026-09');
    assert.equal(reversed.status, 400);
    const tooLong = await admin('GET', '/api/gastos?desde=2024-01&hasta=2026-12');
    assert.equal(tooLong.status, 400);
  });

  test('un pago único necesita importe y fecha válidos', async () => {
    const sinImporte = await admin('POST', '/api/gastos', { category: 'esporadico', name: 'X', date: '2026-10-01' });
    assert.equal(sinImporte.status, 400);
    const proveedor = await admin('POST', '/api/gastos', { category: 'proveedor', name: 'X', amount: 10, date: '2026-10-01' });
    assert.equal(proveedor.code, 'USE_SUPPLIER_MANAGER', 'los pagos a proveedores se apuntan en el gestor');
    const sinFecha = await admin('POST', '/api/gastos', { category: 'esporadico', name: 'X', amount: 10, date: '2026-02-30' });
    assert.equal(sinFecha.status, 400);
    const tipo = await admin('POST', '/api/gastos', { category: 'otro', name: 'X', amount: 10, date: '2026-10-01' });
    assert.equal(tipo.status, 400);
  });

  test('la factura de proveedor sale con su estado y lo pagado a medias', async () => {
    let fra = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.source === 'proveedor');
    assert.equal(fra.invoiceState, 'pendiente');
    const doc = await admin('GET', `/api/proveedores/documentos/${fra.docId}`);
    await admin('POST', `/api/proveedores/documentos/${fra.docId}/pagar?vencimiento_id=${doc.data.vencimientos[0].id}&fecha=2026-10-20`);
    const oct = (await admin('GET', '/api/gastos?mes=2026-10')).data;
    fra = oct.items.find((i) => i.source === 'proveedor');
    assert.equal(fra.invoiceState, 'parcial');
    assert.equal(fra.status, 'pendiente');
    assert.equal(fra.paidCents, 117000);
    assert.equal(oct.totals.paidCents, 117000, 'lo pagado cuenta aunque la factura no esté liquidada');
    assert.equal(oct.totals.pendingCents, 120000 + 18050 + 117000);
  });

  test('un pago único se edita, se paga y se borra en su mes', async () => {
    const oct = (await admin('GET', '/api/gastos?mes=2026-10')).data;
    const persiana = oct.items.find((i) => i.category === 'esporadico');
    await admin('PUT', `/api/gastos/${persiana.id}/importe`, { month: '2026-10', amount: '200' });
    await admin('PUT', `/api/gastos/${persiana.id}/estado`, { month: '2026-10', status: 'pagado' });
    const after = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.id === persiana.id);
    assert.equal(after.amountCents, 20000);
    assert.equal(after.status, 'pagado');
    const del = await admin('POST', `/api/gastos/${persiana.id}/fin`, { month: '2026-10' });
    assert.equal(del.data.deleted, true);
  });
});
