import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { mismoConcepto, nombreMensual } from '../src/antiguo/registros.js';
import { todayInShop } from '../src/services/vacation-balance.js';

// Sincronización con gestiondegastos contra un servidor falso con su misma API.

test('conceptos de gastos mensuales: mismo gasto aunque cambie el detalle', () => {
  assert.equal(nombreMensual({ category: 'Luz', name: 'Endesa' }), 'Luz · Endesa');
  assert.equal(nombreMensual({ category: 'Alquiler', name: 'Alquiler local' }), 'Alquiler local');
  assert.equal(nombreMensual({ category: '', name: '' }), 'Gasto mensual');
  assert.ok(mismoConcepto('Alquiler', 'Alquiler del local'));
  assert.ok(mismoConcepto('Teléfono', 'telefono movil'));
  assert.ok(!mismoConcepto('Luz', 'Alquiler'));
  assert.ok(!mismoConcepto('', 'Luz'));
});

const PDF = Buffer.from('%PDF-1.4\n% factura de prueba\n%%EOF');
const dia = (id, fecha, extra = {}) => ({
  id, sale_date: fecha, worked: true, is_holiday: false, extended_schedule: false,
  morning_cash: 0, morning_card: 0, morning_bizum: 0, morning_bonos: 0,
  morning_cash_customers: 0, morning_card_customers: 0, morning_bizum_customers: 0, morning_bonos_customers: 0,
  afternoon_cash: 0, afternoon_card: 0, afternoon_bizum: 0, afternoon_bonos: 0,
  afternoon_cash_customers: 0, afternoon_card_customers: 0, afternoon_bizum_customers: 0, afternoon_bonos_customers: 0,
  total_sales: 0, customers_total: 0, ...extra,
});

function antiguoFalso() {
  const datos = {
    ventas: [
      dia(1, '2026-10-05', { morning_card: 100, morning_card_customers: 2, afternoon_cash: 50.5, afternoon_cash_customers: 1, total_sales: 150.5, customers_total: 3 }),
      dia(2, '2026-10-06', { morning_card: 210, morning_card_customers: 4, total_sales: 210, customers_total: 4 }),
      dia(3, todayInShop(), { morning_card: 10, total_sales: 10 }),
      dia(4, '2026-01-10', { morning_card: 99, total_sales: 99 }),
    ],
    gastos: [
      { id: 10, sale_date: '2026-10-05', concept: 'Baybu', amount: 20.96 },
      { id: 11, sale_date: '2026-10-06', concept: 'Pago Proveedor - Lejan', amount: 300 },
      { id: 12, sale_date: '2026-10-07', concept: 'Correos', amount: 5 },
      { id: 13, sale_date: '2026-10-07', concept: 'Ferretería', amount: 12.5 },
    ],
    mensuales: [
      { id: 20, month_key: '2026-10', category: 'Alquiler', name: 'Local', amount: 1200 },
      { id: 21, month_key: '2026-10', category: 'Luz', name: '', amount: 85.4 },
      { id: 22, month_key: '2099-12', category: 'Agua', name: '', amount: 30 },
    ],
    adjuntos: [
      { id: 100, sale_date: '2026-10-05', kind: 'gasto', original_filename: 'baybu.pdf', content_type: 'application/pdf' },
      { id: 101, sale_date: '2026-10-07', kind: 'gasto', original_filename: 'correos.pdf', content_type: 'application/pdf' },
      { id: 102, sale_date: '2026-10-07', kind: 'gasto', original_filename: 'ferreteria.pdf', content_type: 'application/pdf' },
      { id: 103, sale_date: '2026-10-05', kind: 'ticket_cierre', original_filename: 'z.pdf', content_type: 'application/pdf' },
    ],
    descargas: [],
  };
  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', (req, res) => {
    if (req.body.username !== 'ivan' || req.body.password !== 'clave-antigua') return res.status(401).json({ detail: 'no' });
    return res.json({ access_token: 'tok', token_type: 'bearer' });
  });
  app.use('/api', (req, res, next) => (req.get('authorization') === 'Bearer tok' ? next() : res.status(401).json({ detail: 'no' })));
  app.get('/api/daily-sales', (_req, res) => res.json(datos.ventas));
  app.get('/api/daily-expenses', (_req, res) => res.json(datos.gastos));
  app.get('/api/monthly-expenses', (_req, res) => res.json(datos.mensuales));
  app.get('/api/daily-attachments', (_req, res) => res.json(datos.adjuntos));
  app.get('/api/daily-attachments/:id/file', (req, res) => {
    datos.descargas.push(Number(req.params.id));
    res.type('application/pdf').send(PDF);
  });
  return { app, datos };
}

describe('Sincronización con gestiondegastos', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let viejo;
  let servidorViejo;
  const items = async (vista) => (await admin('GET', `/api/antiguo/items?vista=${vista}`)).data;

  before(async () => {
    viejo = antiguoFalso();
    servidorViejo = await new Promise((resolve) => {
      const s = viejo.app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${servidorViejo.address().port}`;
    ctx = await startTestServer({ config: { antiguo: { url, usuario: 'ivan', clave: 'clave-antigua', hora: 8 } } });
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
    await new Promise((resolve) => servidorViejo?.close(resolve));
  });

  test('trae lo que falta y no pisa lo que ya está', async () => {
    // En el nuevo ya estaban el día 6 (con otra cifra) y el alquiler.
    await admin('PUT', '/api/ventas/dia/2026-10-06', { manana: { tarjeta: { importe: '200', clientes: 4 } }, dia: { tarjeta: { importe: '200' } } });
    await admin('POST', '/api/gastos', { name: 'Alquiler', kind: 'fijo', amount: '1.150,00', startMonth: '2026-09' });

    const r = await admin('POST', '/api/antiguo/sincronizar');
    assert.equal(r.status, 200, r.error);
    assert.deepEqual(
      { dias: r.data.dias, gastos: r.data.gastos, mensuales: r.data.mensuales, adjuntos: r.data.adjuntos, respetados: r.data.respetados, cambios: r.data.cambios, revisar: r.data.revisar },
      { dias: 1, gastos: 3, mensuales: 1, adjuntos: 1, respetados: 1, cambios: 1, revisar: 2 },
    );
    assert.deepEqual(r.data.errores, []);

    const dia5 = (await admin('GET', '/api/ventas/dia/2026-10-05')).data;
    assert.deepEqual(dia5.manana.tarjeta, { cents: 10000, customers: 2 });
    assert.deepEqual(dia5.tarde.efectivo, { cents: 5050, customers: 1 });
    // Hoy (sin cerrar) y antes del inicio del negocio no se traen; el día 6 no se pisa.
    assert.equal((await admin('GET', `/api/ventas/dia/${todayInShop()}`)).data.exists, false);
    assert.equal((await admin('GET', '/api/ventas/dia/2026-01-10')).data.exists, false);
    assert.equal((await admin('GET', '/api/ventas/dia/2026-10-06')).data.manana.tarjeta.cents, 20000);

    const oct = (await admin('GET', '/api/gastos?mes=2026-10')).data.items;
    const baybu = oct.find((i) => i.name === 'Baybu');
    assert.equal(baybu.category, 'esporadico');
    assert.equal(baybu.amountCents, 2096);
    assert.equal(baybu.status, 'pagado');
    assert.deepEqual(baybu.invoices.map((f) => f.filename), ['baybu.pdf']);
    assert.ok(!oct.some((i) => /Lejan/.test(i.name)), 'el pago a proveedor no se trae');
    assert.equal(oct.find((i) => i.name === 'Luz').amountCents, 8540);
    assert.equal(oct.filter((i) => /Alquiler/.test(i.name)).length, 1, 'el alquiler del nuevo se respeta');
    assert.equal(oct.find((i) => i.name === 'Alquiler').amountCents, 115000);
    assert.equal((await admin('GET', '/api/gastos?mes=2026-11')).data.items.filter((i) => i.name === 'Luz').length, 0, 'el mensual es solo de su mes');
    assert.deepEqual(viejo.datos.descargas, [100]);

    const cambios = await items('cambios');
    assert.equal(cambios.length, 1);
    assert.match(cambios[0].motivo, /Mañana · Tarjeta: 210,00\s€ · 4 clientes \(antiguo\) \/ 200,00\s€ · 4 clientes \(nuevo\)/);
    const revisar = await items('revisar');
    assert.deepEqual(revisar.map((i) => i.titulo).sort(), ['correos.pdf', 'ferreteria.pdf']);
    assert.match(revisar[0].motivo, /2 gastos y 2 archivos/);
    assert.deepEqual(revisar[0].gastos.slice(0, 2).map((g) => g.nombre).sort(), ['Correos', 'Ferretería']);
    const ignorados = await items('ignorados');
    assert.deepEqual(ignorados.map((i) => i.titulo).sort(), ['Alquiler · Local', 'Pago Proveedor - Lejan']);

    const estado = (await admin('GET', '/api/antiguo/estado')).data;
    assert.equal(estado.configurado, true);
    assert.deepEqual(estado.contadores, { cambios: 1, revisar: 2, traidos: 6, ignorados: 2 });
  });

  test('una segunda vez no trae nada repetido', async () => {
    const r = (await admin('POST', '/api/antiguo/sincronizar')).data;
    assert.deepEqual([r.dias, r.gastos, r.mensuales, r.adjuntos, r.cambios, r.revisar], [0, 0, 0, 0, 0, 0]);
    assert.equal((await admin('GET', '/api/gastos?mes=2026-10')).data.items.filter((i) => i.name === 'Baybu').length, 1);
    assert.deepEqual(viejo.datos.descargas, [100]);
  });

  test('un cambio en el antiguo se avisa y se elige: actualizar o mantener', async () => {
    const [cambioDia] = await items('cambios');
    const mantener = await admin('POST', `/api/antiguo/items/${cambioDia.id}`, { accion: 'mantener' });
    assert.equal(mantener.status, 200, mantener.error);
    assert.equal((await admin('GET', '/api/ventas/dia/2026-10-06')).data.manana.tarjeta.cents, 20000);

    viejo.datos.gastos.find((g) => g.id === 10).amount = 22.5;
    const r = (await admin('POST', '/api/antiguo/sincronizar')).data;
    assert.equal(r.cambios, 1, 'el día mantenido no vuelve a salir; el gasto cambiado sí');
    const [cambioGasto] = await items('cambios');
    assert.equal(cambioGasto.titulo, 'Baybu');
    assert.match(cambioGasto.motivo, /Importe: 22,50\s€ \(antiguo\) \/ 20,96\s€ \(nuevo\)/);
    assert.equal((await admin('POST', `/api/antiguo/items/${cambioGasto.id}`, { accion: 'actualizar' })).status, 200);
    const baybu = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.name === 'Baybu');
    assert.equal(baybu.amountCents, 2250);
    assert.equal(baybu.status, 'pagado');
    assert.equal((await items('cambios')).length, 0);
  });

  test('archivos por asignar: a qué gasto y si es factura o justificante', async () => {
    const [archivo] = await items('revisar');
    const ver = await ctx.client()('GET', `/api/antiguo/items/${archivo.id}/archivo`);
    assert.equal(ver.status, 401);
    const pdf = await admin.raw('GET', `/api/antiguo/items/${archivo.id}/archivo`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);

    const correos = archivo.gastos.find((g) => g.nombre === 'Correos');
    const mal = await admin('POST', `/api/antiguo/items/${archivo.id}`, { accion: 'asignar', gasto_id: correos.id, tipo: 'otro' });
    assert.equal(mal.status, 400);
    const ok = await admin('POST', `/api/antiguo/items/${archivo.id}`, { accion: 'asignar', gasto_id: correos.id, tipo: 'justificante' });
    assert.equal(ok.status, 200, ok.error);
    const gasto = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.name === 'Correos');
    assert.equal(gasto.receipts.length, 1);
    assert.equal(gasto.status, 'pagado');
    assert.equal((await admin('POST', `/api/antiguo/items/${archivo.id}`, { accion: 'asignar', gasto_id: correos.id, tipo: 'factura' })).status, 409);

    // «Otros»: factura de otro comercio → gasto esporádico nuevo de ese día, con el PDF.
    const [otro] = await items('revisar');
    const sinImporte = await admin('POST', `/api/antiguo/items/${otro.id}`, { accion: 'asignar', gasto_id: 'nuevo', concepto: 'Bazar Chino', tipo: 'factura' });
    assert.equal(sinImporte.status, 400);
    const nuevo = await admin('POST', `/api/antiguo/items/${otro.id}`, {
      accion: 'asignar', gasto_id: 'nuevo', concepto: 'Bazar Chino', importe: '8,40', tipo: 'factura',
    });
    assert.equal(nuevo.status, 200, nuevo.error);
    const bazar = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.name === 'Bazar Chino');
    assert.equal(bazar.category, 'esporadico');
    assert.equal(bazar.date, '2026-10-07');
    assert.equal(bazar.amountCents, 840);
    assert.equal(bazar.invoices.length, 1);
    assert.equal((await items('revisar')).length, 0);
  });

  test('quitar algo traído: se borra y no vuelve; «traer» lo recupera', async () => {
    const luz = (await items('traidos')).find((i) => i.titulo === 'Luz');
    assert.equal((await admin('POST', `/api/antiguo/items/${luz.id}`, { accion: 'quitar' })).status, 200);
    assert.ok(!(await admin('GET', '/api/gastos?mes=2026-10')).data.items.some((i) => i.name === 'Luz'));
    await admin('POST', '/api/antiguo/sincronizar');
    assert.ok(!(await admin('GET', '/api/gastos?mes=2026-10')).data.items.some((i) => i.name === 'Luz'), 'no se vuelve a traer');

    const dia = (await items('traidos')).find((i) => i.origen === 'dia');
    assert.equal((await admin('POST', `/api/antiguo/items/${dia.id}`, { accion: 'quitar' })).status, 409, 'los días se corrigen en Caja');

    const ignorada = (await items('ignorados')).find((i) => i.titulo === 'Luz');
    assert.equal((await admin('POST', `/api/antiguo/items/${ignorada.id}`, { accion: 'traer' })).status, 200);
    assert.equal((await admin('GET', '/api/gastos?mes=2026-10')).data.items.filter((i) => i.name === 'Luz').length, 1);

    // Un gasto borrado desde Gastos tampoco vuelve.
    const ferreteria = (await admin('GET', '/api/gastos?mes=2026-10')).data.items.find((i) => i.name === 'Ferretería');
    await admin('POST', `/api/gastos/${ferreteria.id}/fin`, { month: '2026-10' });
    await admin('POST', '/api/antiguo/sincronizar');
    assert.ok(!(await admin('GET', '/api/gastos?mes=2026-10')).data.items.some((i) => i.name === 'Ferretería'));
  });

  test('dos mensuales de la misma categoría se traen los dos; ignorar un cambio y luego traerlo no falla', async () => {
    viejo.datos.mensuales.push(
      { id: 23, month_key: '2026-10', category: 'Seguro', name: 'Local', amount: 40 },
      { id: 24, month_key: '2026-10', category: 'Seguro', name: 'Mercancía', amount: 25 },
    );
    const r = (await admin('POST', '/api/antiguo/sincronizar')).data;
    assert.equal(r.mensuales, 2);
    const oct = (await admin('GET', '/api/gastos?mes=2026-10')).data.items;
    assert.deepEqual(oct.filter((i) => i.name.startsWith('Seguro')).map((i) => i.amountCents).sort(), [2500, 4000]);

    viejo.datos.mensuales.find((m) => m.id === 23).amount = 45;
    await admin('POST', '/api/antiguo/sincronizar');
    const [cambio] = await items('cambios');
    assert.equal(cambio.titulo, 'Seguro · Local');
    assert.equal((await admin('POST', `/api/antiguo/items/${cambio.id}`, { accion: 'ignorar' })).status, 200);
    const ignorado = (await items('ignorados')).find((i) => i.id === cambio.id);
    const traer = await admin('POST', `/api/antiguo/items/${ignorado.id}`, { accion: 'traer' });
    assert.equal(traer.status, 200, traer.error);
    assert.equal((await admin('GET', '/api/gastos?mes=2026-10')).data.items.filter((i) => i.name === 'Seguro · Local').length, 1);
    // Vuelve a avisar del cambio pendiente en la siguiente pasada.
    await admin('POST', '/api/antiguo/sincronizar');
    assert.equal((await items('cambios')).length, 1);
    const asignarMal = await admin('POST', `/api/antiguo/items/${cambio.id}`, { accion: 'asignar', gasto_id: 'x', tipo: 'factura' });
    assert.equal(asignarMal.status, 409);
  });

  test('permisos y errores de conexión', async () => {
    assert.equal((await admin('GET', '/api/antiguo/items?vista=nada')).status, 400);
    assert.equal((await ctx.client()('POST', '/api/antiguo/sincronizar')).status, 401);
    const bad = await startTestServer({ config: { antiguo: { url: ctx.baseUrl.replace(/:\d+$/, ':1'), usuario: 'x', clave: 'y', hora: 8 } } });
    try {
      const a = await bad.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
      const r = await a('POST', '/api/antiguo/sincronizar');
      assert.equal(r.status, 502);
      assert.match(r.error, /No se pudo conectar con gestiondegastos/);
      const estado = (await a('GET', '/api/antiguo/estado')).data;
      assert.match(estado.ultima.error, /No se pudo conectar/);
    } finally {
      await bad.stop();
    }
  });
});
