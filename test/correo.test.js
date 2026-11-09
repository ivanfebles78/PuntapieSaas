import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mesDelTexto, reconocerGasto } from '../src/correo/gastos.js';
import { tocaHoy } from '../src/correo/programador.js';
import { esRemitenteIgnorado, revisarCorreo } from '../src/correo/procesar.js';
import { applySchema } from '../src/db/migrate.js';
import { faltaParaRegistrar } from '../src/correo/proveedor.js';
import { DocumentoPdf } from '../src/proveedores/pdf/documento.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import { fixtureBytes, HAY_FIXTURES } from './proveedores-fixtures.js';

/** PDF de prueba con unas líneas de texto. */
function pdf(...lineas) {
  const doc = new DocumentoPdf();
  lineas.forEach((t, i) => doc.texto(t, 20, 20 + i * 8));
  return doc.construir();
}

const AGUA = () => pdf('FACTURA Nº Factura VMP2026-S005 Fecha emisión 01-10-26', 'DE: VICENTE MATILLA PÉREZ', 'Consumo Agua 05/2026', 'Total a pagar 28,45 €');
const CANARAGUA = () => pdf('MATILLA PEREZ, VICENTE J. Fecha: 17/09/2026', 'Nº Contrato: 109600668 DATOS DE SUMINISTRO', 'TOTAL 28,45 €');
const MOVISTAR = () => pdf('04 de Octubre de 2026 Página 1 de 6', 'Factura núm: FM4KAJJ000', 'miMovistar 59,19 €', 'Total a pagar 94,26 €');
const ALARMA = (total) => pdf('Nº contrato: MPAB2B0473171 Fecha de emisión: 12.10.2026', 'MOVISTAR PROSEGUR ALARMAS, S.L', `Total factura ${total} €`);
const JUSTIFICANTE = () => pdf('1/1 Transferencia ordenada Estado: En destino', 'Importe total 61,57 EUR', 'Concepto Pago Luz');
const CATALOGO = () => pdf('Catálogo primavera-verano', 'Novedades para tu tienda');

/* ---------- Reglas ---------- */

test('los gastos se reconocen por su contenido, no por el nombre del archivo', () => {
  assert.deepEqual(reconocerGasto('ARRENDADORA: María Jesús FACTURA Fecha emisión 01-09-26 Alquiler 25% local'), { gasto: 'alquiler', clase: 'factura' });
  assert.deepEqual(reconocerGasto('Descripción Consumo Agua 05/2026 28,45 €'), { gasto: 'agua', clase: 'factura' });
  assert.deepEqual(reconocerGasto('Consumo Electricidad 01-12-25 al 31-12-25'), { gasto: 'luz', clase: 'factura' });
  assert.deepEqual(reconocerGasto('MOVISTAR PROSEGUR ALARMAS, S.L con C.I.F B87222006'), { gasto: 'alarma', clase: 'factura' });
  assert.deepEqual(reconocerGasto('Factura núm: FM4KAJJ000 miMovistar'), { gasto: 'movistar', clase: 'factura' });
  assert.deepEqual(reconocerGasto('RESPONSABLE · Asociación de Empresarios de Santa Cruz de Tenerife - Zona Centro'), { gasto: 'asociacion', clase: 'factura' });
  assert.deepEqual(reconocerGasto('ATECRE,S.A. N.I.F.: A38031878 info@atecresa.com'), { gasto: 'atecresa', clase: 'factura' });
  assert.deepEqual(reconocerGasto('LAFUENTE GESTORIA ADMINISTRATIVA SL'), { gasto: 'asesoria', clase: 'factura' });
  assert.equal(reconocerGasto('1/1 Transferencia ordenada Estado En destino').clase, 'justificante');
  assert.equal(reconocerGasto('Nº Contrato: 109600668 DATOS DE SUMINISTRO').clase, 'original');
  assert.equal(reconocerGasto('GARVALIN S.A. Factura 2613709'), null);
});

test('el mes sale de la fecha de emisión en cualquiera de sus formatos', () => {
  assert.equal(mesDelTexto('Fecha emisión 01-09-26'), '2026-09');
  assert.equal(mesDelTexto('Fecha de emisión: 12.10.2026'), '2026-10');
  assert.equal(mesDelTexto('04 de Octubre de 2026 Página 1'), '2026-10');
  assert.equal(mesDelTexto('Fecha: 22/01/2026'), '2026-01');
  assert.equal(mesDelTexto('sin fechas'), null);
});

test('una factura de proveedor solo se registra sola si está completa y cuadra', () => {
  const ok = { parser: 'garvalin', tipo: 'factura', proveedor: { nombre: 'Garvalín' }, numero: 'F1', fecha: '2026-10-01', total_cent: 1000, vencimientos: [{ fecha: '2026-11-01', importe_cent: 1000 }] };
  assert.equal(faltaParaRegistrar(ok), null);
  assert.match(faltaParaRegistrar({ ...ok, parser: 'generico' }), /sin lector/);
  assert.match(faltaParaRegistrar({ ...ok, numero: null }), /número/);
  assert.match(faltaParaRegistrar({ ...ok, vencimientos: [{ fecha: '2026-11-01', importe_cent: 900 }] }), /no suman/);
  assert.equal(faltaParaRegistrar({ ...ok, tipo: 'pedido', total_cent: null, vencimientos: [] }), null, 'un pedido no necesita total ni vencimientos');
});

/* ---------- Revisión del buzón ---------- */

/** Buzón de mentira: devuelve los correos que no se han visto y apunta los marcados como leídos. */
function buzonFalso(mensajes) {
  const leidos = [];
  const abrir = (trabajo) => trabajo({
    async noLeidos({ vistos }) { return mensajes.filter((m) => !leidos.includes(m.uid) && !vistos.has(m.messageId)); },
    async marcarLeido(uid) { leidos.push(uid); },
  });
  return { abrir, leidos };
}

const correo = (uid, adjuntos, extra = {}) => ({
  uid, messageId: `<m${uid}@test>`, from: 'alguien@ejemplo.com', subject: `Correo ${uid}`, date: new Date('2026-10-02T09:00:00Z'), adjuntos, ...extra,
});

describe('revisión del correo', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let ids;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const alta = async (body) => (await admin('POST', '/api/gastos', { category: 'recurrente', startMonth: '2026-04', ...body })).data.id;
    ids = {
      agua: await alta({ name: 'Agua', kind: 'variable' }),
      movistar: await alta({ name: 'Movistar (Teléfono e internet)', kind: 'variable' }),
      alarma: await alta({ name: 'Alarma', kind: 'fijo', amount: '59,62' }),
    };
  });
  after(async () => {
    await ctx?.stop();
  });

  const item = async (id, mes) => (await admin('GET', `/api/gastos?desde=${mes}&hasta=${mes}`)).data.items.find((i) => i.id === id);

  test('registra gastos y facturas, deja para revisar lo dudoso y marca leído solo lo registrado', async () => {
    const mensajes = [
      correo(1, [{ filename: 'agua.pdf', data: AGUA() }, { filename: 'canaragua.pdf', data: CANARAGUA() }]),
      correo(2, [{ filename: 'movistar.pdf', data: MOVISTAR() }]),
      correo(3, [{ filename: 'pago.pdf', data: JUSTIFICANTE() }]),
      correo(4, []),
      correo(5, [{ filename: 'catalogo.pdf', data: CATALOGO() }]),
      correo(6, [{ filename: 'alarma.pdf', data: ALARMA('58,23') }]),
      ...(HAY_FIXTURES ? [correo(7, [{ filename: 'garvalin.pdf', data: fixtureBytes('Garvalin/2613709 (2).pdf') }])] : []),
    ];
    const buzon = buzonFalso(mensajes);
    const r = await revisarCorreo(ctx.pool, { abrirBuzon: buzon.abrir, origen: 'manual', inicio: '2026-04', log: { error() {} } });

    assert.equal(r.correos, mensajes.length);
    assert.equal(r.gastos, 3, 'agua, movistar y alarma');
    assert.deepEqual(buzon.leidos.sort(), [1, 2, 6, ...(HAY_FIXTURES ? [7] : [])], 'el justificante, el catálogo y el correo sin PDF siguen sin leer');

    // Agua: en el mes en que llega el correo, con su importe; la factura original no se adjunta.
    const agua = await item(ids.agua, '2026-10');
    assert.equal(agua.amountCents, 2845);
    assert.equal(agua.invoices.length, 1);
    assert.equal(agua.status, 'pendiente', 'el agua se paga por transferencia');
    // Movistar: en el mes de su fecha, domiciliado → pagado.
    const movistar = await item(ids.movistar, '2026-10');
    assert.deepEqual([movistar.amountCents, movistar.status], [9426, 'pagado']);
    // Alarma (fija): si la factura es distinta, cambia solo ese mes.
    const alarma = await item(ids.alarma, '2026-10');
    assert.deepEqual([alarma.amountCents, alarma.status], [5823, 'pagado']);
    assert.equal((await item(ids.alarma, '2026-11')).amountCents, 5962, 'los meses siguientes no cambian');

    const pend = (await admin('GET', '/api/correo/pendientes')).data;
    assert.deepEqual(pend.filter((p) => p.estado === 'revisar').map((p) => p.archivo).sort(), ['catalogo.pdf', 'pago.pdf']);
    assert.match(pend.find((p) => p.archivo === 'pago.pdf').motivo, /Justificante/);
    if (HAY_FIXTURES) {
      const docs = (await admin('GET', '/api/proveedores/documentos?tipo=factura')).data;
      assert.ok(docs.some((d) => d.numero === '2613709'), 'la factura de Garvalín se ha registrado sola');
    }
  });

  test('una segunda revisión no repite nada; la misma factura en otro correo no se adjunta dos veces', async () => {
    const otraVez = buzonFalso([correo(1, [{ filename: 'agua.pdf', data: AGUA() }]), correo(8, [{ filename: 'agua-bis.pdf', data: AGUA() }])]);
    const r = await revisarCorreo(ctx.pool, { abrirBuzon: otraVez.abrir, origen: 'manual', inicio: '2026-04', log: { error() {} } });
    assert.equal(r.correos, 1, 'el correo 1 ya se había visto');
    assert.equal(r.ignorados, 1);
    assert.equal((await item(ids.agua, '2026-10')).invoices.length, 1);
  });

  test('lo pendiente se revisa en Importar PDF; al guardarlo queda resuelto y el correo se marca leído', async () => {
    const pend = (await admin('GET', '/api/correo/pendientes')).data;
    const catalogo = pend.find((p) => p.archivo === 'catalogo.pdf');
    const pdfRes = await admin.raw('GET', `/api/correo/pendientes/${catalogo.id}/archivo`);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const an = await admin('POST', `/api/correo/pendientes/${catalogo.id}/analizar`);
    assert.equal(an.status, 200);
    assert.equal(an.data.correo_id, catalogo.id);
    const doc = await admin('POST', '/api/proveedores/documentos', {
      tempId: an.data.tempId, tipo: 'factura', proveedor: { nombre: 'Proveedor nuevo' }, numero: 'C-1', fecha: '2026-10-01', total_cent: 500,
    });
    assert.equal(doc.status, 201);
    const ahora = (await admin('GET', '/api/correo/pendientes')).data;
    assert.ok(!ahora.some((p) => p.id === catalogo.id), 'ya no está para revisar');

    const pago = ahora.find((p) => p.archivo === 'pago.pdf');
    assert.equal((await admin('POST', `/api/correo/pendientes/${pago.id}/descartar`)).status, 200);
    assert.equal((await admin('POST', `/api/correo/pendientes/${pago.id}/descartar`)).status, 409);

    const buzon = buzonFalso([]);
    await revisarCorreo(ctx.pool, { abrirBuzon: buzon.abrir, origen: 'manual', inicio: '2026-04', log: { error() {} } });
    assert.deepEqual(buzon.leidos, [5], 'el correo del PDF registrado a mano ya se marca leído; el descartado no');
  });

  test('historial del asistente: cada correo, cuándo se marcó leído y qué hizo con cada PDF', async () => {
    const h = (await admin('GET', '/api/correo/historial')).data;
    const de = (n) => h.items.find((i) => i.asunto === `Correo ${n}`);
    assert.equal(h.total, HAY_FIXTURES ? 8 : 7);
    assert.ok(h.revisiones.length >= 3, 'las últimas revisiones, con su resumen');

    const movistar = de(2);
    assert.equal(movistar.leido, true);
    assert.ok(movistar.leido_el, 'guarda cuándo se marcó como leído');
    assert.equal(movistar.documentos[0].resultado, 'gasto');
    assert.deepEqual(movistar.documentos[0].gasto, { id: ids.movistar, nombre: 'Movistar (Teléfono e internet)', mes: '2026-10' });
    assert.match(movistar.documentos[0].motivo, /pagado \(domiciliado\)/);

    assert.deepEqual(de(1).documentos.map((d) => d.resultado), ['gasto', 'ya_estaba'], 'el agua se adjunta; la original no');
    const catalogo = de(5);
    assert.deepEqual([catalogo.leido, catalogo.documentos[0].resultado], [true, 'a_mano']);
    assert.deepEqual([catalogo.documentos[0].factura.numero, catalogo.documentos[0].factura.proveedor], ['C-1', 'Proveedor nuevo']);
    assert.deepEqual([de(3).leido, de(3).leido_el, de(3).documentos[0].resultado], [false, null, 'descartado']);
    if (HAY_FIXTURES) {
      const garvalin = de(7).documentos[0];
      assert.deepEqual([garvalin.resultado, garvalin.factura.numero], ['factura', '2613709']);
    }

    const conRegistro = (await admin('GET', '/api/correo/historial?resultado=registro')).data.items.map((i) => i.asunto).sort();
    assert.deepEqual(conRegistro, ['Correo 1', 'Correo 2', 'Correo 6', ...(HAY_FIXTURES ? ['Correo 7'] : [])]);
    const sinLeer = (await admin('GET', '/api/correo/historial?leido=no')).data.items;
    assert.ok(sinLeer.length > 0 && sinLeer.every((i) => !i.leido));
    assert.deepEqual((await admin('GET', '/api/correo/historial?q=movistar')).data.items.map((i) => i.asunto), ['Correo 2']);
    assert.equal((await admin('GET', '/api/correo/historial?resultado=raro')).status, 400);
    assert.equal((await admin('GET', '/api/correo/historial?desde=ayer')).status, 400);
  });

  test('los extractos del datáfono (resumen@) se descartan sin leerlos y no quedan para revisar', async () => {
    assert.ok(esRemitenteIgnorado('resumen@redsys.es'));
    assert.ok(esRemitenteIgnorado(' Resumen@banco.example '));
    assert.ok(!esRemitenteIgnorado('facturas-resumen@proveedor.example'));

    const buzon = buzonFalso([correo(40, [{ filename: 'extracto.pdf', data: MOVISTAR() }], { from: 'resumen@datafono.example' })]);
    const antes = (await item(ids.movistar, '2026-10')).amountCents;
    const r = await revisarCorreo(ctx.pool, { abrirBuzon: buzon.abrir, origen: 'manual', inicio: '2026-04', log: { error() {} } });
    assert.deepEqual([r.correos, r.gastos, r.revisar], [1, 0, 0]);
    assert.deepEqual(buzon.leidos, [], 'el correo se queda sin leer');
    assert.equal((await item(ids.movistar, '2026-10')).amountCents, antes, 'el PDF no se ha leído como factura');
    const pend = (await admin('GET', '/api/correo/pendientes')).data;
    assert.ok(!pend.some((p) => p.archivo === 'extracto.pdf'));
    const guardado = (await ctx.pool.query(
      `SELECT a.state, a.data FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_ref WHERE m.message_id = '<m40@test>'`)).rows;
    assert.deepEqual(guardado, [{ state: 'descartado', data: null }]);

    // Lo que quedó para revisar antes de ignorarlos se descarta al arrancar.
    const msg = (await ctx.pool.query(
      `INSERT INTO mail_messages (message_id, uid, from_addr, subject) VALUES ('<viejo@test>', 41, 'resumen@datafono.example', 'Resumen') RETURNING id`)).rows[0];
    await ctx.pool.query(
      `INSERT INTO mail_attachments (message_ref, filename, sha256, kind, state, reason, data) VALUES ($1, 'viejo.pdf', 'x', 'desconocido', 'revisar', 'dudoso', decode('00', 'hex'))`, [msg.id]);
    await applySchema(ctx.pool);
    const viejo = (await ctx.pool.query('SELECT state, data FROM mail_attachments WHERE message_ref = $1', [msg.id])).rows;
    assert.deepEqual(viejo, [{ state: 'descartado', data: null }]);
  });

  test('estado, permisos y sin correo conectado', async () => {
    const estado = await admin('GET', '/api/correo/estado');
    assert.equal(estado.data.configurado, false);
    assert.equal(estado.data.ultima.origen, 'manual');
    assert.equal((await admin('POST', '/api/correo/revisar')).status, 409, 'sin GMAIL_USER no se puede revisar');
    const users = (await admin('GET', '/api/admin/users')).data;
    await admin('PATCH', `/api/admin/users/${users.find((u) => u.username === 'rperez').id}`, { role: 'asesor' });
    const asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal((await asesor('GET', '/api/correo/pendientes')).status, 200);
    assert.equal((await asesor('POST', '/api/correo/revisar')).status, 403);
    assert.equal((await asesor('GET', '/api/correo/historial')).status, 200, 'el Asesor ve el historial (solo lectura)');
    const empleado = await ctx.loginAs('epena', 'Test1234');
    await empleado('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    assert.equal((await empleado('GET', '/api/correo/historial')).status, 403, 'el historial es de Admin');
  });

  test('la revisión diaria toca a partir de las 8:00 de Canarias, una vez al día', async () => {
    await ctx.pool.query('DELETE FROM mail_runs');
    const a = (h) => new Date(`2026-11-03T${h}:00Z`); // Canarias en invierno = UTC
    assert.equal(await tocaHoy(ctx.pool, 8, a('07:59')), false);
    assert.equal(await tocaHoy(ctx.pool, 8, a('08:01')), true);
    await ctx.pool.query("INSERT INTO mail_runs (origin, started_at, finished_at) VALUES ('auto', $1, $1)", [a('08:01')]);
    assert.equal(await tocaHoy(ctx.pool, 8, a('15:00')), false, 'ya se hizo hoy');
    await ctx.pool.query("UPDATE mail_runs SET error = 'Gmail caído'");
    assert.equal(await tocaHoy(ctx.pool, 8, a('08:30')), false, 'tras un fallo espera una hora');
    assert.equal(await tocaHoy(ctx.pool, 8, a('09:05')), true);
  });
});
