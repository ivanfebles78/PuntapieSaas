import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatoCodigo, leerCodigoVale, nuevoCodigoVale } from '../src/tpv/vales.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

test('código de vale: sin letras que se confundan, y se lee con o sin guiones', () => {
  const c = nuevoCodigoVale(2026);
  assert.match(c, /^V26[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(leerCodigoVale(formatoCodigo(c).toLowerCase()), c);
  assert.equal(leerCodigoVale('2001234567890'), null, 'un código de barras de producto no es un vale');
});

describe('TPV: cambios y vales', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elena;
  const art = {};
  let valeCodigo;

  const vender = async (articulo, pago, descuento = null) => (await elena('POST', '/api/tpv/ventas', {
    lineas: [{ articulo_id: articulo.id, cantidad: 1, descuento }], pagos: [pago],
  })).data;
  const stock = async (a) => (await admin('GET', '/api/stock/inventario')).data.articulos.find((x) => x.id === a.id).stock;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    const ped = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Gioseppo' }, numero: 'P-CAMBIOS', total_cent: 100,
      lineas: [
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'A1', modelo: 'Alba', color: 'Rosa', talla: 30, cantidad: 2, pvp_cent: 5995 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'B1', modelo: 'Bruno', color: 'Azul', talla: 30, cantidad: 2, pvp_cent: 3995 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'C1', modelo: 'Celia', color: 'Oro', talla: 30, cantidad: 1, pvp_cent: 8995 },
      ],
    });
    await admin('POST', `/api/stock/entradas/${ped.data.id}/recibir`, {});
    for (const a of (await admin('GET', '/api/stock/inventario')).data.articulos) art[a.referencia] = a;
    await elena('POST', '/api/tpv/caja/abrir', { recuento: { 2000: 5 } });
  });
  after(async () => {
    await ctx?.stop();
  });

  test('devolución por un vale: rectificativa en su serie (R), vale lo que se pagó, vuelve al stock y el vale caduca en un año', async () => {
    const venta = await vender(art.A1, { metodo: 'tarjeta', importe_cent: 5395 }, { tipo: 'pct', valor: 10 });
    assert.equal(venta.total_cent, 5395);
    const info = await elena('GET', `/api/tpv/cambios/articulo?q=${art.A1.codigo}`);
    const v = info.data.ventas[0];
    assert.deepEqual([v.ticket, v.precio_unidad_cent, v.quedan, v.dentro_plazo], [venta.numero, 5395, 1, true]);

    const calc = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: [{ linea_id: v.linea_id, cantidad: 1 }] });
    assert.deepEqual([calc.data.credito_cent, calc.data.a_pagar_cent, calc.data.vale_cent, calc.data.requiere_aprobacion], [5395, 0, 5395, false]);
    const antes = await stock(art.A1);
    const r = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: v.linea_id, cantidad: 1 }] });
    assert.equal(r.status, 201);
    const rect = r.data.rectificativa;
    assert.equal(rect.tipo, 'rectificativa');
    assert.match(rect.numero, /^R\d{2}-000001$/, 'las rectificativas tienen su propia serie');
    assert.deepEqual(rect.rectifica, [venta.numero], 'dice qué venta rectifica');
    assert.equal(rect.total_cent, 5395);
    assert.equal(rect.igic.base_cent + rect.igic.cuota_cent, -5395, 'base e IGIC en negativo');
    assert.ok(rect.igic.base_cent < 0);
    assert.equal(rect.devueltos[0].credito_cent, 5395);
    assert.equal(r.data.venta, null, 'no se lleva nada: no hay venta');
    assert.equal(r.data.vale.ticket_origen, rect.numero);
    assert.equal(r.data.vale.importe_cent, 5395);
    assert.equal(r.data.vale.saldo_cent, 5395);
    assert.match(r.data.vale.qr_svg, /^<svg/);
    assert.equal(r.data.vale.validez_meses, 12);
    const enUnAno = new Date();
    enUnAno.setFullYear(enUnAno.getFullYear() + 1);
    assert.equal(r.data.vale.caduca.slice(-4), String(enUnAno.getFullYear()));
    assert.equal(await stock(art.A1), antes + 1, 'lo devuelto vuelve al stock');
    valeCodigo = r.data.vale.codigo;

    const otra = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: v.linea_id, cantidad: 1 }] });
    assert.equal(otra.status, 400, 'no se puede devolver dos veces lo mismo');
    assert.match(otra.error, /solo quedan 0/);

    const doble = await vender(art.A1, { metodo: 'tarjeta', importe_cent: 5995 });
    const lineaDoble = (await elena('GET', `/api/tpv/cambios/articulo?q=${art.A1.codigo}`)).data.ventas.find((x) => x.ticket === doble.numero).linea_id;
    const repetida = await elena('POST', '/api/tpv/cambios/calcular', { devueltos: [{ linea_id: lineaDoble, cantidad: 1 }, { linea_id: lineaDoble, cantidad: 1 }] });
    assert.equal(repetida.status, 400, 'la misma venta dos veces en el mismo cambio cuenta junta');
  });

  test('cambio por algo más caro: paga la diferencia; por algo más barato: el resto, en vale', async () => {
    const vB = await vender(art.B1, { metodo: 'efectivo', importe_cent: 3995 });
    const lineaB = (await elena('GET', `/api/tpv/cambios/articulo?q=${art.B1.codigo}`)).data.ventas[0].linea_id;
    const sinPagar = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: lineaB, cantidad: 1 }], nuevos: [{ articulo_id: art.C1.id, cantidad: 1 }] });
    assert.equal(sinPagar.status, 400, 'hay que cobrar la diferencia');
    const caro = await elena('POST', '/api/tpv/cambios', {
      devueltos: [{ linea_id: lineaB, cantidad: 1 }], nuevos: [{ articulo_id: art.C1.id, cantidad: 1 }], pagos: [{ metodo: 'tarjeta', importe_cent: 5000 }],
    });
    assert.equal(caro.status, 201);
    const { rectificativa: rc, venta: vc } = caro.data;
    assert.deepEqual([rc.total_cent, rc.rectifica, caro.data.vale], [3995, [vB.numero], null]);
    assert.match(vc.numero, /^T\d{2}-/, 'lo nuevo es una venta normal, con su IGIC entero');
    assert.equal(vc.total_cent, 8995);
    assert.equal(vc.igic.base_cent + vc.igic.cuota_cent, 8995);
    assert.deepEqual(vc.pagos.map((p) => [p.metodo, p.importe_cent]), [['abono', 3995], ['tarjeta', 5000]]);
    assert.deepEqual([vc.vinculado, rc.vinculado], [rc.numero, vc.numero], 'cada documento cita al otro');
    assert.equal(await stock(art.C1), 0);
    const caja = (await elena('GET', '/api/tpv/caja')).data.abierta;
    assert.equal(caja.por_metodo.abono, undefined, 'el abono no es dinero de la caja');

    // Ahora devuelve el C1 (sale del ticket del cambio) y se lleva el B1: sobran 50 € en vale.
    const lineaC = (await elena('GET', `/api/tpv/cambios/articulo?q=${art.C1.codigo}`)).data.ventas[0].linea_id;
    const barato = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: lineaC, cantidad: 1 }], nuevos: [{ articulo_id: art.B1.id, cantidad: 1 }] });
    assert.equal(barato.status, 201);
    assert.deepEqual([barato.data.rectificativa.total_cent, barato.data.rectificativa.rectifica], [8995, [vc.numero]]);
    assert.deepEqual(barato.data.venta.pagos.map((p) => [p.metodo, p.importe_cent]), [['abono', 3995]]);
    assert.equal(barato.data.vale.importe_cent, 5000);
    assert.equal(await stock(art.C1), 1);
  });

  test('pagar con vale: hay que escanearlo, descuenta saldo y no deja pasar del saldo', async () => {
    const sinCodigo = await elena('POST', '/api/tpv/ventas', { lineas: [{ articulo_id: art.B1.id, cantidad: 1 }], pagos: [{ metodo: 'vales', importe_cent: 3995 }] });
    assert.equal(sinCodigo.code, 'VOUCHER_REQUIRED');
    const r = await elena('POST', '/api/tpv/ventas', {
      lineas: [{ articulo_id: art.B1.id, cantidad: 1 }], pagos: [{ metodo: 'vales', importe_cent: 3995, vale: formatoCodigo(valeCodigo) }],
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.pagos[0].vale, formatoCodigo(valeCodigo));
    const vale = (await elena('GET', `/api/tpv/buscar?q=${valeCodigo}`)).data.vale;
    assert.deepEqual([vale.estado, vale.saldo_cent, vale.usos.length], ['activo', 1400, 1]);
    const mucho = await elena('POST', '/api/tpv/ventas', {
      lineas: [{ articulo_id: art.A1.id, cantidad: 1 }], pagos: [{ metodo: 'vales', importe_cent: 5995, vale: valeCodigo }],
    });
    assert.equal(mucho.code, 'VOUCHER_BALANCE');
    assert.match(mucho.error, /14,00 €/);
    const mixto = await elena('POST', '/api/tpv/ventas', {
      lineas: [{ articulo_id: art.A1.id, cantidad: 1 }], pagos: [{ metodo: 'vales', importe_cent: 1400, vale: valeCodigo }, { metodo: 'tarjeta', importe_cent: 4595 }],
    });
    assert.equal(mixto.status, 201);
    assert.equal((await elena('GET', `/api/tpv/vales/${valeCodigo}`)).data.estado, 'agotado');
  });

  test('un vale caducado no se acepta', async () => {
    const r = await elena('GET', `/api/tpv/vales/${valeCodigo}`);
    await ctx.pool.query("UPDATE tpv_vouchers SET balance_cents = 1000, expires_on = CURRENT_DATE - 1 WHERE code = $1", [valeCodigo]);
    const caducado = await elena('POST', '/api/tpv/ventas', {
      lineas: [{ articulo_id: art.B1.id, cantidad: 1 }], pagos: [{ metodo: 'vales', importe_cent: 1000, vale: valeCodigo }, { metodo: 'tarjeta', importe_cent: 2995 }],
    });
    assert.equal(caducado.code, 'VOUCHER_EXPIRED');
    assert.equal((await elena('GET', `/api/tpv/vales/${valeCodigo}`)).data.estado, 'caducado');
    assert.equal(r.status, 200);
  });

  test('ticket de papel (compra antes del TPV) o fuera de plazo: con aprobación de un Administrador', async () => {
    const papel = { articulo_id: art.A1.id, cantidad: 1, importe_cent: 5995, ticket_papel: '000123', fecha_ticket: '2026-10-20' };
    const sin = await elena('POST', '/api/tpv/cambios', { devueltos: [papel] });
    assert.equal(sin.code, 'EXCHANGE_NEEDS_APPROVAL');
    const remota = await elena('POST', '/api/tpv/cambios/aprobaciones', { devueltos: [papel] });
    assert.match(decodeURIComponent(remota.data.enlace_whatsapp), /Elena pide aceptar un cambio por 59,95 € en Puntapié \(ticket de papel/);
    const ap = await elena('POST', '/api/tpv/cambios/aprobaciones/presencial', { usuario: ADMIN_EMAIL, contrasena: ADMIN_PASSWORD, devueltos: [papel] });
    assert.equal(ap.data.estado, 'aprobado');
    const otroImporte = await elena('POST', '/api/tpv/cambios', { devueltos: [{ ...papel, importe_cent: 6995 }], aprobacion_id: ap.data.id });
    assert.equal(otroImporte.status, 403, 'la aprobación es por ese importe');
    const ok = await elena('POST', '/api/tpv/cambios', { devueltos: [papel], aprobacion_id: ap.data.id });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.vale.importe_cent, 5995);
    assert.deepEqual(ok.data.rectificativa.rectifica, ['ticket de papel 000123']);
    assert.equal((await admin('POST', '/api/tpv/cambios', { devueltos: [papel] })).status, 201, 'el Administrador no necesita aprobación');

    // Una venta de hace 40 días: fuera de plazo.
    const vieja = await vender(art.B1, { metodo: 'tarjeta', importe_cent: 3995 });
    await ctx.pool.query("UPDATE tpv_tickets SET sold_at = NOW() - INTERVAL '40 days' WHERE id = $1", [vieja.id]);
    const linea = (await elena('GET', `/api/tpv/cambios/articulo?q=${art.B1.codigo}`)).data.ventas.find((x) => x.ticket === vieja.numero);
    assert.equal(linea.dentro_plazo, false);
    assert.equal((await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: linea.linea_id, cantidad: 1 }] })).code, 'EXCHANGE_NEEDS_APPROVAL');
  });

  test('con la caja cerrada no se hacen cambios', async () => {
    const r = (await elena('GET', '/api/tpv/caja')).data.abierta;
    await admin('POST', '/api/tpv/caja/cerrar', { recuento: { 2000: 5 } });
    const linea = (await elena('GET', `/api/tpv/cambios/articulo?q=${art.B1.codigo}`)).data.ventas.find((x) => x.quedan > 0 && x.dentro_plazo);
    const c = await elena('POST', '/api/tpv/cambios', { devueltos: [{ linea_id: linea.linea_id, cantidad: 1 }] });
    assert.equal(c.code, 'CASH_CLOSED');
    assert.ok(r);
  });

  test('(al final: bloquea el resto de pruebas) buscar vales por código: muchos códigos que no existen seguidos se bloquean', async () => {
    let ultimo;
    for (const letra of 'ABCDEFGHJKLMNPQRSTUVW') ultimo = await elena('GET', `/api/tpv/vales/V26ZZZZ${letra}ZZZ`);
    assert.equal(ultimo.status, 429);
    assert.equal(ultimo.code, 'TOO_MANY_VOUCHER_LOOKUPS');
    assert.equal((await elena('GET', '/api/tpv/buscar?q=Gioseppo')).status, 200, 'buscar productos no se bloquea');
  });
});
