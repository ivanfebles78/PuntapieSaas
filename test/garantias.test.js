import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from '../src/db/migrate.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('TPV: defectuosos, cuarentena y garantías', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elena;
  const art = {};

  const vender = async (articulo, pago) => (await elena('POST', '/api/tpv/ventas', { lineas: [{ articulo_id: articulo.id, cantidad: 1 }], pagos: [pago] })).data;
  const stock = async (a) => (await admin('GET', '/api/stock/inventario')).data.articulos.find((x) => x.id === a.id).stock;
  const lineaDe = async (a) => (await elena('GET', `/api/tpv/cambios/articulo?q=${a.codigo}`)).data.ventas[0];
  const caja = async () => (await elena('GET', '/api/tpv/caja')).data.abierta;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    const ped = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Gioseppo' }, numero: 'P-GARANTIA', total_cent: 100,
      lineas: [
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'D1', modelo: 'Dana', color: 'Rojo', talla: 28, cantidad: 3, pvp_cent: 4995 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'E1', modelo: 'Eva', color: 'Gris', talla: 28, cantidad: 2, pvp_cent: 6995 },
      ],
    });
    await admin('POST', `/api/stock/entradas/${ped.data.id}/recibir`, {});
    for (const a of (await admin('GET', '/api/stock/inventario')).data.articulos) art[a.referencia] = a;
    await elena('POST', '/api/tpv/caja/abrir', { recuento: { 2000: 5 } });
  });
  after(async () => {
    await ctx?.stop();
  });

  test('defectuoso con devolución del dinero: no vuelve al stock, abre una incidencia y sale de la caja', async () => {
    await vender(art.D1, { metodo: 'efectivo', importe_cent: 4995, entregado_cent: 5000 });
    const v = await lineaDe(art.D1);
    const sinDefecto = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: [{ linea_id: v.linea_id, cantidad: 1, estado: 'defectuoso' }] });
    assert.equal(sinDefecto.status, 400, 'hay que decir qué defecto tiene');
    assert.match(sinDefecto.error, /defecto/);

    const dev = [{ linea_id: v.linea_id, cantidad: 1, estado: 'defectuoso', defecto: 'Se despega la suela' }];
    const calc = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: dev });
    assert.deepEqual([calc.data.defectuoso_cent, calc.data.reembolsable_cent, calc.data.vale_cent], [4995, 4995, 4995]);
    const conDinero = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: dev, reembolso: 'efectivo' });
    assert.deepEqual([conDinero.data.reembolso_cent, conDinero.data.vale_cent], [4995, 0]);
    assert.deepEqual(conDinero.data.motivos, ['devolución de dinero'], 'dar dinero lo aprueba un Administrador');

    const sinAprobar = await elena('POST', '/api/tpv/cambios', { devueltos: dev, reembolso: 'efectivo' });
    assert.equal(sinAprobar.status, 403);
    assert.equal(sinAprobar.code, 'EXCHANGE_NEEDS_APPROVAL');
    // Una aprobación de este mismo cambio con vale no sirve para llevarse el dinero.
    const presencial = (body) => elena('POST', '/api/tpv/cambios/aprobaciones/presencial', { usuario: ADMIN_EMAIL, contrasena: ADMIN_PASSWORD, ...body });
    const conDefectoEnBuenEstado = await presencial({ devueltos: [{ linea_id: v.linea_id, cantidad: 1 }] });
    assert.equal(conDefectoEnBuenEstado.status, 400, 'en buen estado y dentro de plazo no hace falta aprobación');
    const otra = await presencial({ devueltos: dev, reembolso: 'tarjeta' });
    assert.equal((await elena('POST', '/api/tpv/cambios', { devueltos: dev, reembolso: 'efectivo', aprobacion_id: otra.data.id })).status, 403,
      'aprobado en tarjeta no vale para efectivo');
    const ap = await presencial({ devueltos: dev, reembolso: 'efectivo' });
    assert.equal(ap.data.estado, 'aprobado');

    const antes = await stock(art.D1);
    const cajaAntes = await caja();
    const r = await elena('POST', '/api/tpv/cambios', { devueltos: dev, reembolso: 'efectivo', aprobacion_id: ap.data.id });
    assert.equal(r.status, 201);
    assert.equal(r.data.vale, null, 'en un defectuoso no se impone el vale');
    assert.deepEqual(r.data.rectificativa.reembolso, { metodo: 'efectivo', importe_cent: 4995 });
    assert.equal(r.data.rectificativa.devueltos[0].estado, 'defectuoso');
    assert.equal(r.data.incidencias.length, 1);
    assert.equal(await stock(art.D1), antes, 'lo defectuoso no vuelve a la venta');
    const cajaDespues = await caja();
    assert.equal(cajaDespues.esperado_cent, cajaAntes.esperado_cent - 4995, 'el efectivo devuelto sale de la caja');
    assert.equal(cajaDespues.reembolsos_cent, 4995);

    const lista = await elena('GET', '/api/garantias');
    assert.equal(lista.status, 200);
    const inc = lista.data.items[0];
    assert.deepEqual([inc.estado, inc.defecto, inc.proveedor, inc.rectificativa, inc.cantidad], ['abierta', 'Se despega la suela', 'Gioseppo', r.data.rectificativa.numero, 1]);
    assert.equal(lista.data.totales.en_cuarentena, 1);
  });

  test('lo que está bien no se devuelve en dinero, y el dinero no pasa de lo que vale lo defectuoso', async () => {
    await vender(art.D1, { metodo: 'tarjeta', importe_cent: 4995 });
    const v = await lineaDe(art.D1);
    const bien = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: v.linea_id, cantidad: 1 }], reembolso: 'tarjeta' });
    assert.equal(bien.status, 400);
    assert.match(bien.error, /defectuosos/);
    // Defectuoso y se lleva algo más caro: todo el abono se gasta en lo nuevo, no hay dinero que devolver.
    const mas = await elena('POST', '/api/tpv/cambios/calcular', {
      devueltos: [{ linea_id: v.linea_id, cantidad: 1, estado: 'defectuoso', defecto: 'Costura rota' }], nuevos: [{ articulo_id: art.E1.id, cantidad: 1 }],
    });
    assert.deepEqual([mas.data.a_pagar_cent, mas.data.reembolsable_cent, mas.data.vale_cent], [2000, 0, 0]);
  });

  test('ticket de papel de hace más de 30 días: si es defectuoso solo pide aprobación por el ticket (la garantía dura 3 años)', async () => {
    const hace40 = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const papel = { articulo_id: art.E1.id, cantidad: 1, importe_cent: 6995, ticket_papel: '123', fecha_ticket: hace40 };
    const bien = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: [papel] });
    assert.deepEqual(bien.data.motivos, ['ticket de papel', 'más de 30 días']);
    const defectuoso = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: [{ ...papel, estado: 'defectuoso', defecto: 'Velcro roto' }] });
    assert.deepEqual(defectuoso.data.motivos, ['ticket de papel']);
  });

  test('incidencia: fotos, reclamación al proveedor y resolución (solo un Administrador); con sustitución vuelve al stock', async () => {
    const id = (await elena('GET', '/api/garantias')).data.items[0].id;
    const sube = await elena.raw('POST', `/api/garantias/${id}/archivos`, { body: PNG, headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('suela.png') } });
    assert.equal(sube.status, 201);
    const malo = await elena.raw('POST', `/api/garantias/${id}/archivos`, { body: Buffer.from('hola'), headers: { 'Content-Type': 'image/png', 'X-File-Name': 'x.png' } });
    assert.equal(malo.status, 415);
    const det = await elena('GET', `/api/garantias/${id}`);
    assert.equal(det.data.archivos.length, 1);
    const foto = await elena.raw('GET', `/api/garantias/archivos/${det.data.archivos[0].id}`);
    assert.equal(foto.headers.get('content-type'), 'image/png');

    const edit = await elena('PATCH', `/api/garantias/${id}`, { defecto: 'Se despega la suela del pie izquierdo' });
    assert.equal(edit.data.defecto, 'Se despega la suela del pie izquierdo');
    const rec = await elena('POST', `/api/garantias/${id}/reclamar`, { referencia: 'RMA-77' });
    assert.equal(rec.data.estado, 'reclamada');
    assert.equal(rec.data.reclamacion.referencia, 'RMA-77');

    const empleado = await elena('POST', `/api/garantias/${id}/resolver`, { resolucion: 'sustitucion' });
    assert.equal(empleado.status, 403, 'la resuelve un Administrador');
    const sinImporte = await admin('POST', `/api/garantias/${id}/resolver`, { resolucion: 'abono' });
    assert.equal(sinImporte.status, 400, 'un abono lleva su importe');
    const antes = await stock(art.D1);
    const ok = await admin('POST', `/api/garantias/${id}/resolver`, { resolucion: 'sustitucion', notas: 'Mandan un par nuevo' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.estado, 'resuelta');
    assert.equal(await stock(art.D1), antes + 1, 'el par de sustitución vuelve al stock');
    assert.equal((await admin('POST', `/api/garantias/${id}/resolver`, { resolucion: 'rechazada' })).status, 409, 'no se resuelve dos veces');
    assert.equal((await elena('PATCH', `/api/garantias/${id}`, { defecto: 'otra cosa' })).status, 409);
    assert.equal((await elena('GET', '/api/garantias')).data.totales.en_cuarentena, 0);
    assert.equal((await elena('GET', '/api/garantias?estado=resueltas')).data.items[0].resolucion.tipo, 'sustitucion');

    const log = await admin('GET', '/api/admin/log?area=garantias');
    assert.ok(log.data.items.length >= 3, 'queda en el log');
  });

  test('el esquema se vuelve a aplicar al arrancar aunque ya haya rectificativas y aprobaciones de cambios', async () => {
    await ctx.pool.query(
      "INSERT INTO tpv_discount_requests (kind, token_hash, requested_by, channel, percent, subtotal_cents, total_cents, expires_at) SELECT 'cambio', 'hash-esquema', id, 'presencial', 100, 100, 100, NOW() FROM users LIMIT 1",
    );
    assert.ok((await ctx.pool.query("SELECT 1 FROM tpv_tickets WHERE kind = 'rectificativa'")).rowCount > 0);
    await applySchema(ctx.pool);
  });
});
