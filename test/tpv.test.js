import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularVenta } from '../public/tpv/calculo.js';
import { enviarAviso, textoAviso } from '../src/tpv/whatsapp.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

/* ---------- Cálculo ---------- */

test('descuentos por línea y al total, y la regla del 15 % (sin falsos avisos por redondeo)', () => {
  const v = calcularVenta([{ precio_cent: 5995, cantidad: 1, descuento: { tipo: 'pct', valor: 10 } }, { precio_cent: 500, cantidad: 2 }], { tipo: 'eur', valor: 300 });
  assert.deepEqual([v.subtotal_cent, v.total_cent, v.descuento_cent], [6995, 6095, 900]);
  assert.equal(v.lineas.reduce((s, l) => s + l.total_cent, 0), v.total_cent, 'las líneas suman el total');
  assert.equal(v.requiere_aprobacion, false);
  assert.equal(calcularVenta([{ precio_cent: 333, cantidad: 1, descuento: { tipo: 'pct', valor: 15 } }]).requiere_aprobacion, false, '15 % justo vale');
  assert.equal(calcularVenta([{ precio_cent: 333, cantidad: 1 }, { precio_cent: 777, cantidad: 3 }], { tipo: 'pct', valor: 15 }).requiere_aprobacion, false);
  assert.equal(calcularVenta([{ precio_cent: 5000, cantidad: 1, descuento: { tipo: 'pct', valor: 10 } }], { tipo: 'pct', valor: 10 }).requiere_aprobacion, true, '10 % + 10 % = 19 %');
  assert.equal(calcularVenta([{ precio_cent: 5000, cantidad: 1, descuento: { tipo: 'pct', valor: 16 } }, { precio_cent: 9000, cantidad: 1 }]).requiere_aprobacion, true, 'una línea por encima aunque el total no');
  assert.equal(calcularVenta([{ precio_cent: 5000, cantidad: 1, descuento: { tipo: 'eur', valor: 800 } }]).requiere_aprobacion, true, '8 € de 50 € = 16 %');
  assert.throws(() => calcularVenta([{ precio_cent: 500, cantidad: 1, descuento: { tipo: 'eur', valor: 600 } }]), /mayor que el importe/);
  assert.throws(() => calcularVenta([]), /no tiene productos/);
});

test('el aviso de WhatsApp usa la plantilla con quién, %, total y enlace', async () => {
  const llamadas = [];
  const enviar = async (url, opts) => { llamadas.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return { ok: true }; };
  const cfg = { token: 'tok', phoneId: '123', plantilla: 'aprobacion_descuento', idioma: 'es', aprobadores: ['34600111222', '34600333444'] };
  const datos = { quien: 'Elena', pct: 25, total: 6675, enlace: 'https://x/app/ventas/tpv?aprobar=abc' };
  assert.equal(await enviarAviso(cfg, datos, { enviar }), 2);
  assert.equal(llamadas[0].url, 'https://graph.facebook.com/v21.0/123/messages');
  assert.equal(llamadas[0].auth, 'Bearer tok');
  assert.deepEqual(llamadas[1].body.template.components[0].parameters.map((p) => p.text), ['Elena', '25 %', '66,75 €', datos.enlace]);
  assert.match(textoAviso(datos), /Elena pide un descuento del 25 % en una venta de 66,75 €/);
});

/* ---------- API ---------- */

describe('TPV: venta', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elena;
  let arts;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    // Stock: un pedido recibido con dos tallas de un zapato y un juguete.
    const ped = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Gioseppo' }, numero: 'P-TPV', total_cent: 100,
      lineas: [
        { tipo: 'calzado', marca: 'Gioseppo', referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 30, cantidad: 2, coste_cent: 2915, pvp_cent: 5995 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 31, cantidad: 1, coste_cent: 2915, pvp_cent: 5995 },
        { tipo: 'juguetes', marca: 'Cayro', referencia: '843', modelo: 'Parchís', cantidad: 1, pvp_cent: 1990 },
      ],
    });
    await admin('POST', `/api/stock/entradas/${ped.data.id}/recibir`, {});
    arts = (await admin('GET', '/api/stock/inventario')).data.articulos;
  });
  after(async () => {
    await ctx?.stop();
  });

  const talla = (t) => arts.find((a) => a.talla === t);
  const venta = (lineas, extra = {}) => ({ lineas, ...extra });

  test('buscar: el código da el artículo exacto; el texto, los modelos con sus tallas', async () => {
    const exacto = await elena('GET', `/api/tpv/buscar?q=${talla('30').codigo}`);
    assert.equal(exacto.data.exacto.id, talla('30').id);
    await admin('PUT', `/api/stock/articulos/${arts.find((a) => a.marca === 'Cayro').id}`, { codigo_fabricante: '4006381333931' });
    assert.equal((await elena('GET', '/api/tpv/buscar?q=4006381333931')).data.exacto.marca, 'Cayro', 'también por el código de la caja');
    const texto = await elena('GET', '/api/tpv/buscar?q=gioseppo%20cuero');
    assert.equal(texto.data.modelos.length, 1);
    assert.deepEqual(texto.data.modelos[0].tallas.map((t) => [t.talla, t.stock]), [['30', 2], ['31', 1]]);
    assert.equal((await elena('GET', '/api/tpv/buscar?q=nada%20de%20nada')).data.modelos.length, 0);
  });

  test('cobro repartido entre efectivo y tarjeta: ticket, cambio, stock y estadísticas', async () => {
    const lineas = [
      { articulo_id: talla('30').id, cantidad: 1, precio_cent: 1 }, // el precio lo pone el stock, no la pantalla
      { descripcion: 'Plantillas', precio_cent: 800, cantidad: 2, tipo: 'accesorios' },
    ];
    const calc = await elena('POST', '/api/tpv/calcular', venta(lineas));
    assert.equal(calc.data.total_cent, 7595);
    const mal = await elena('POST', '/api/tpv/ventas', venta(lineas, { pagos: [{ metodo: 'tarjeta', importe_cent: 7000 }] }));
    assert.equal(mal.status, 400);
    assert.match(mal.error, /suman 70\.00 €/);
    const r = await elena('POST', '/api/tpv/ventas', venta(lineas, {
      pagos: [{ metodo: 'efectivo', importe_cent: 2595, entregado_cent: 3000 }, { metodo: 'tarjeta', importe_cent: 5000 }],
    }));
    assert.equal(r.status, 201);
    assert.match(r.data.numero, /^T\d{2}-000001$/);
    assert.equal(r.data.cambio_cent, 405);
    assert.equal(r.data.vendedor, 'Elena');
    assert.deepEqual(r.data.igic, { pct: 7, base_cent: 7098, cuota_cent: 497 });
    const stock = (await admin('GET', '/api/stock/inventario')).data.articulos.find((a) => a.id === talla('30').id).stock;
    assert.equal(stock, 1, 'sale del stock');
    const ventas = (await ctx.pool.query('SELECT payment_method, total_cents FROM sales WHERE ticket_id = $1 ORDER BY id', [r.data.id])).rows;
    assert.deepEqual(ventas.map((v) => [v.payment_method, v.total_cents]), [['efectivo', 2595], ['tarjeta', 5000]]);
    assert.equal((await elena('GET', `/api/tpv/tickets/${r.data.id}`)).data.lineas.length, 2);
  });

  test('vender lo que el sistema da por agotado se permite, pero se avisa', async () => {
    const r = await elena('POST', '/api/tpv/ventas', venta([{ articulo_id: talla('31').id, cantidad: 2 }], { pagos: [{ metodo: 'bizum', importe_cent: 11990 }] }));
    assert.equal(r.status, 201);
    assert.equal(r.data.sin_stock.length, 1);
    assert.equal(r.data.lineas[0].sin_stock, true);
    assert.equal((await admin('GET', '/api/stock/inventario')).data.articulos.find((a) => a.id === talla('31').id).stock, 0);
  });

  const conDescuento = (pct) => venta([{ articulo_id: talla('30').id, cantidad: 1, descuento: { tipo: 'pct', valor: pct } }]);

  test('hasta el 15 % lo pone quien vende; más, necesita aprobación (el Administrador no)', async () => {
    const ok = await elena('POST', '/api/tpv/ventas', { ...conDescuento(15), pagos: [{ metodo: 'tarjeta', importe_cent: 5096 }] });
    assert.equal(ok.error, undefined);
    assert.equal(ok.error, undefined);
    assert.equal(ok.status, 201);
    const no = await elena('POST', '/api/tpv/ventas', { ...conDescuento(20), pagos: [{ metodo: 'tarjeta', importe_cent: 4796 }] });
    assert.equal(no.status, 403);
    assert.equal(no.code, 'DISCOUNT_NEEDS_APPROVAL');
    const jefe = await admin('POST', '/api/tpv/ventas', { ...conDescuento(30), pagos: [{ metodo: 'tarjeta', importe_cent: 4196 }] });
    assert.equal(jefe.status, 201);
  });

  test('aprobación en persona: usuario y contraseña de un Administrador; vale una sola vez', async () => {
    const malo = await elena('POST', '/api/tpv/aprobaciones/presencial', { usuario: ADMIN_EMAIL, contrasena: 'mal', venta: conDescuento(20) });
    assert.equal(malo.status, 403);
    const noAdmin = await elena('POST', '/api/tpv/aprobaciones/presencial', { usuario: 'epena', contrasena: 'Elena2026x', venta: conDescuento(20) });
    assert.equal(noAdmin.status, 403, 'una empleada no se aprueba a sí misma');
    const ap = await elena('POST', '/api/tpv/aprobaciones/presencial', { usuario: ADMIN_EMAIL, contrasena: ADMIN_PASSWORD, venta: conDescuento(20) });
    assert.equal(ap.status, 201);
    assert.equal(ap.data.estado, 'aprobado');
    const mas = await elena('POST', '/api/tpv/ventas', { ...conDescuento(25), pagos: [{ metodo: 'tarjeta', importe_cent: 4496 }], aprobacion_id: ap.data.id });
    assert.equal(mas.status, 403, 'aprobado un 20 %, no vale para un 25 %');
    const r = await elena('POST', '/api/tpv/ventas', { ...conDescuento(20), pagos: [{ metodo: 'tarjeta', importe_cent: 4796 }], aprobacion_id: ap.data.id });
    assert.equal(r.status, 201);
    const otra = await elena('POST', '/api/tpv/ventas', { ...conDescuento(20), pagos: [{ metodo: 'tarjeta', importe_cent: 4796 }], aprobacion_id: ap.data.id });
    assert.equal(otra.status, 403, 'ya usada');
  });

  test('aprobación a distancia: aviso por WhatsApp, el Administrador decide desde el enlace', async () => {
    assert.equal((await elena('POST', '/api/tpv/aprobaciones', { venta: conDescuento(10) })).status, 400, 'un 10 % no necesita aprobación');
    const s = await elena('POST', '/api/tpv/aprobaciones', { venta: conDescuento(30) });
    assert.equal(s.status, 201);
    assert.equal(s.data.estado, 'pendiente');
    assert.equal(s.data.enviado, false, 'sin claves de Meta no se envía solo');
    assert.match(s.data.enlace_whatsapp, /^https:\/\/wa\.me\/34600111222\?text=/);
    const texto = decodeURIComponent(s.data.enlace_whatsapp.split('text=')[1]);
    assert.match(texto, /Elena pide un descuento del 30 %/);
    const token = new URL(texto.match(/https?:\/\/\S+/)[0]).searchParams.get('aprobar');

    assert.equal((await elena('GET', `/api/tpv/aprobar/${token}`)).status, 403, 'solo un Administrador abre el enlace');
    const vista = await admin('GET', `/api/tpv/aprobar/${token}`);
    assert.deepEqual([vista.data.solicitante, vista.data.pct, vista.data.lineas.length], ['Elena', 30, 1]);
    assert.equal((await elena('GET', `/api/tpv/aprobaciones/${s.data.id}`)).data.estado, 'pendiente');
    const sinAprobar = await elena('POST', '/api/tpv/ventas', { ...conDescuento(30), pagos: [{ metodo: 'tarjeta', importe_cent: 4196 }], aprobacion_id: s.data.id });
    assert.equal(sinAprobar.status, 403);

    assert.equal((await admin('POST', `/api/tpv/aprobar/${token}`, { decision: 'aprobar' })).data.estado, 'aprobado');
    assert.equal((await admin('POST', `/api/tpv/aprobar/${token}`, { decision: 'rechazar' })).status, 409, 'ya decidida');
    assert.equal((await elena('GET', `/api/tpv/aprobaciones/${s.data.id}`)).data.estado, 'aprobado');
    const r = await elena('POST', '/api/tpv/ventas', { ...conDescuento(30), pagos: [{ metodo: 'tarjeta', importe_cent: 4196 }], aprobacion_id: s.data.id });
    assert.equal(r.status, 201);

    const s2 = await elena('POST', '/api/tpv/aprobaciones', { venta: conDescuento(40) });
    const t2 = new URL(decodeURIComponent(s2.data.enlace_whatsapp.split('text=')[1]).match(/https?:\/\/\S+/)[0]).searchParams.get('aprobar');
    await admin('POST', `/api/tpv/aprobar/${t2}`, { decision: 'rechazar' });
    assert.equal((await elena('GET', `/api/tpv/aprobaciones/${s2.data.id}`)).data.estado, 'rechazado');
    assert.equal((await elena('POST', '/api/tpv/ventas', { ...conDescuento(40), pagos: [{ metodo: 'tarjeta', importe_cent: 3597 }], aprobacion_id: s2.data.id })).status, 403);
  });

  test('el Asesor no vende', async () => {
    const users = (await admin('GET', '/api/admin/users')).data;
    await admin('PATCH', `/api/admin/users/${users.find((u) => u.username === 'rperez').id}`, { role: 'asesor' });
    const asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal((await asesor('POST', '/api/tpv/ventas', { ...conDescuento(0), pagos: [{ metodo: 'tarjeta', importe_cent: 5995 }] })).status, 403);
  });
});
