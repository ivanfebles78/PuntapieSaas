import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lineasFactura, lineasPedido } from '../src/proveedores/parsers/gioseppo.js';
import { colorSimple, esPropuesta, lineasPropuesta } from '../src/proveedores/parsers/pablosky.js';
import { digitoControl, esEan13, nuevoCodigo } from '../src/stock/barcode.js';
import { ETIQUETA, generarEtiquetasPdf, modulosEan13 } from '../src/stock/pdf/etiquetas.js';
import { validarLineas } from '../src/stock/repo.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

/* ---------- Código de barras y etiquetas ---------- */

test('EAN-13 como la web antigua: prefijo 200, 9 aleatorios y dígito de control GS1', () => {
  assert.equal(digitoControl('400638133393'), 1); // ejemplo clásico de GS1
  assert.ok(esEan13('4006381333931'));
  assert.ok(!esEan13('4006381333932'));
  for (let i = 0; i < 50; i += 1) {
    const code = nuevoCodigo();
    assert.match(code, /^200\d{10}$/);
    assert.ok(esEan13(code), code);
  }
});

test('los 95 módulos del EAN-13 tienen sus guardas y se decodifican al mismo número', () => {
  const code = '4006381333931';
  const m = modulosEan13(code);
  assert.equal(m.length, 95);
  assert.equal(m.slice(0, 3), '101');
  assert.equal(m.slice(45, 50), '01010');
  assert.equal(m.slice(92), '101');
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = L.map((x) => [...x].map((b) => (b === '1' ? '0' : '1')).reverse().join(''));
  const R = L.map((x) => [...x].map((b) => (b === '1' ? '0' : '1')).join(''));
  const izq = Array.from({ length: 6 }, (_, i) => m.slice(3 + i * 7, 10 + i * 7));
  const der = Array.from({ length: 6 }, (_, i) => m.slice(50 + i * 7, 57 + i * 7));
  const digitosIzq = izq.map((p) => (L.includes(p) ? L.indexOf(p) : G.indexOf(p)));
  assert.equal(`${digitosIzq.join('')}${der.map((p) => R.indexOf(p)).join('')}`, code.slice(1));
});

test('etiquetas en PDF de 50 × 25 mm: una página por unidad', () => {
  const e = { marca: 'Gioseppo', referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 40, codigo: `200123456789${digitoControl('200123456789')}`, pvp_cent: 6995 };
  const pdf = generarEtiquetasPdf([e, e, { ...e, talla: 41, pvp_cent: null }]).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.equal((pdf.match(/\/Type \/Page /g) ?? []).length, 3);
  assert.match(pdf, new RegExp(`/MediaBox \\[0 0 ${Math.round(ETIQUETA.ancho * 100) / 100} ${Math.round(ETIQUETA.alto * 100) / 100}\\]`));
  assert.match(pdf, /\(T\. 40\)/);
  assert.match(pdf, /\(69,95 \x80\)/);
});

/* ---------- Lectores de líneas ---------- */

test('Gioseppo, pedido: una línea por talla y las cajas multiplican la composición', () => {
  const lineas = lineasPedido([
    '1 - 9 82871-SOLELVAL Cuero 40-45: 2, 2, 2, 1, 1, 1 = 9 Pares 28/02/2027 29,15 € 262,35 € 69,95 €',
    '123 2 16 82809-VALAE Oro Rosado 28-30: 1, 0, 1 = 2 Pares 15/03/2027 18,73 € 74,92 € 44,95 €',
    '1 - 2 81023-PLV KIDS Azul UNICO: 2 Pares 28/02/2027 0,00 € 0,00 € 0,00 €',
  ]);
  assert.deepEqual(lineas.slice(0, 2), [
    { marca: 'Gioseppo', referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 40, cantidad: 2, coste_cent: 2915, pvp_cent: 6995 },
    { marca: 'Gioseppo', referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 41, cantidad: 2, coste_cent: 2915, pvp_cent: 6995 },
  ]);
  const valae = lineas.filter((l) => l.referencia === '82809');
  assert.deepEqual(valae.map((l) => [l.talla, l.cantidad, l.color]), [[28, 8], [30, 8]].map(([t, c]) => [t, c, 'Oro Rosado']));
  assert.equal(lineas.reduce((s, l) => s + l.cantidad, 0), 9 + 16, 'el expositor (sin tallas, 0 €) no es stock');
});

test('Gioseppo, factura: una línea por talla; el color va antes de la familia en mayúsculas', () => {
  assert.deepEqual(lineasFactura(['80514-P1 80514 Oro Rosado CAS&SPORT BABY GI 6402999100 21 1 16,65 16,65', 'Total Base Imp.']), [
    { marca: 'Gioseppo', referencia: '80514', modelo: '80514', color: 'Oro Rosado', talla: 21, cantidad: 1, coste_cent: 1665, pvp_cent: null },
  ]);
});

test('Pablosky, propuesta de pedido: empareja PARES con TALLAS por posición', () => {
  const fila = (y, celdas) => ({ y, items: celdas.map(([x, s]) => ({ x, s })), text: celdas.map(([, s]) => s).join(' ') });
  const lines = [
    fila(700, [[40, 'Modelo'], [80, '064224'], [140, 'Color'], [180, 'NOBUCK-TECH'], [240, 'MARINO'], [300, 'Piso'], [330, 'NOBUCK']]),
    fila(690, [[40, '20-23'], [80, '28,27'], [120, 'PVPR'], [150, '59,95'], [200, '24-27'], [240, '29,72'], [280, 'PVPR'], [310, '62,95']]),
    fila(680, [[40, 'TALLAS'], [100, '20'], [130, '21'], [160, '22'], [190, '23'], [220, '24'], [250, '25']]),
    fila(670, [[40, 'PARES'], [101, '1'], [161, '2'], [251, '3']]),
    fila(600, [[40, 'Total Pares: 6']]),
  ];
  assert.ok(esPropuesta(lines));
  assert.deepEqual(lineasPropuesta(lines).map((l) => [l.referencia, l.modelo, l.color, l.talla, l.cantidad, l.coste_cent, l.pvp_cent]), [
    ['064224', 'Nobuck', 'Azul Marino', 20, 1, 2827, 5995],
    ['064224', 'Nobuck', 'Azul Marino', 22, 2, 2827, 5995],
    ['064224', 'Nobuck', 'Azul Marino', 25, 3, 2972, 6295],
  ]);
  assert.equal(colorSimple('LEADER-TECH ROSA'), 'Rosa');
});

test('validarLineas junta el mismo SKU y rechaza datos imposibles', () => {
  const l = { marca: 'Gioseppo', referencia: '1', color: 'Rosa', talla: 30, cantidad: 2 };
  const v = validarLineas([l, { ...l, cantidad: 3, pvp_cent: 3995 }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].cantidad, 5);
  assert.equal(v[0].modelo, '1', 'sin modelo, se usa la referencia');
  assert.equal(v[0].pvp_cent, 3995);
  assert.throws(() => validarLineas([{ ...l, cantidad: 0 }]), /cantidad/);
  assert.throws(() => validarLineas([{ ...l, talla: 99 }]), /talla/);
  assert.throws(() => validarLineas('x'), /lista/);
});

/* ---------- API ---------- */

const LINEAS = Object.freeze([
  { referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 40, cantidad: 2, coste_cent: 2915, pvp_cent: 6995 },
  { referencia: '82871', modelo: 'Solelval', color: 'Cuero', talla: 41, cantidad: 1, coste_cent: 2915, pvp_cent: 6995 },
  { referencia: '78547', modelo: 'Morley', color: 'Marino', talla: 24, cantidad: 3, coste_cent: 1665, pvp_cent: 3995 },
]);

describe('API de stock: pedido → etiquetas → recepción', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let pedido;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  test('al guardar el pedido con productos, quedan pendientes de recibir (no disponibles)', async () => {
    const res = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'GIOSEPPO, S.L.U', cif: 'B03503034' }, numero: 'P-G-1', fecha: '2026-10-01', total_cent: 10000,
      marca: 'Gioseppo', lineas: LINEAS.map((l) => ({ ...l, marca: 'Gioseppo' })),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.data.entrada, { lineas: 3, unidades: 6, articulos_nuevos: 3, omitido: null });
    pedido = res.data;
    const inv = (await admin('GET', '/api/stock/inventario')).data;
    assert.equal(inv.resumen.disponible, 0);
    assert.equal(inv.resumen.pendiente, 6);
    assert.ok(inv.articulos.every((a) => /^200\d{10}$/.test(a.codigo) && a.stock === 0));
    const enCamino = (await admin('GET', '/api/stock/inventario?estado=pendiente')).data.articulos;
    assert.equal(enCamino.length, 3);
    const lista = (await admin('GET', '/api/stock/entradas')).data;
    assert.equal(lista[0].totales.pendientes, 6);
  });

  test('líneas no válidas: no se guarda ni el documento', async () => {
    const res = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Gioseppo', cif: 'B03503034' }, numero: 'P-G-MAL', total_cent: 100,
      lineas: [{ marca: 'Gioseppo', referencia: '1', color: 'Rosa', talla: 30, cantidad: -1 }],
    });
    assert.equal(res.status, 400);
    const docs = (await admin('GET', '/api/proveedores/documentos?tipo=pedido')).data;
    assert.ok(!docs.some((d) => d.numero === 'P-G-MAL'));
  });

  test('etiquetas: una por unidad, y se pueden reimprimir por línea o por artículo', async () => {
    const pdf = await admin.raw('GET', `/api/stock/etiquetas.pdf?doc=${pedido.id}`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const texto = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.equal((texto.match(/\/Type \/Page /g) ?? []).length, 6);
    const e = (await admin('GET', `/api/stock/entradas/${pedido.id}`)).data;
    const linea = e.lineas.find((l) => l.cantidad === 3);
    const una = Buffer.from(await (await admin.raw('GET', `/api/stock/etiquetas.pdf?doc=${pedido.id}&lineas=${linea.id}`)).arrayBuffer()).toString('latin1');
    assert.equal((una.match(/\/Type \/Page /g) ?? []).length, 3);
    const art = Buffer.from(await (await admin.raw('GET', `/api/stock/etiquetas.pdf?articulo=${linea.articulo.id}&copias=2`)).arrayBuffer()).toString('latin1');
    assert.equal((art.match(/\/Type \/Page /g) ?? []).length, 2);
    assert.equal((await admin.raw('GET', '/api/stock/etiquetas.pdf?articulo=999999')).status, 404);
  });

  test('la factura del mismo pedido no duplica los productos', async () => {
    const res = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'factura', proveedor: { nombre: 'GIOSEPPO, S.L.U', cif: 'B03503034' }, numero: 'FAC-1', fecha: '2026-10-05', total_cent: 10000,
      pedidos: ['P-G-1'], vencimientos: [{ fecha: '2026-12-01', importe_cent: 10000 }], lineas: LINEAS.map((l) => ({ ...l, marca: 'Gioseppo' })),
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.entrada.unidades, 0);
    assert.equal(res.data.entrada.omitido.numero, 'P-G-1');
    assert.equal((await admin('GET', '/api/stock/inventario')).data.resumen.pendiente, 6);
  });

  test('recepción con una falta: lo recibido pasa a stock y lo que falta queda para reclamar', async () => {
    const e = (await admin('GET', `/api/stock/entradas/${pedido.id}`)).data;
    const tres = e.lineas.find((l) => l.cantidad === 3);
    assert.equal((await admin('POST', `/api/stock/entradas/${pedido.id}/recibir`, { faltan: { [tres.id]: 4 } })).status, 400);
    const res = await admin('POST', `/api/stock/entradas/${pedido.id}/recibir`, { faltan: { [tres.id]: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.recibidas, 5);
    assert.equal(res.data.faltan, 1);
    const inv = (await admin('GET', '/api/stock/inventario')).data;
    assert.equal(inv.resumen.disponible, 5);
    assert.equal(inv.resumen.pendiente, 0);
    assert.equal(inv.resumen.faltan, 1);
    assert.equal((await admin('POST', `/api/stock/entradas/${pedido.id}/recibir`, {})).code, 'NOTHING_PENDING');
    const reclamar = (await admin('GET', '/api/stock/entradas?estado=faltas')).data;
    assert.equal(reclamar.length, 1);

    const llegado = await admin('POST', `/api/stock/lineas/${tres.id}/llegado`);
    assert.equal(llegado.status, 200);
    assert.equal((await admin('GET', '/api/stock/inventario')).data.resumen.disponible, 6);
    assert.equal((await admin('POST', `/api/stock/lineas/${tres.id}/anular`)).code, 'NOT_MISSING');
  });

  test('el mismo SKU en otro pedido reutiliza su código de barras', async () => {
    const antes = (await admin('GET', '/api/stock/inventario')).data.articulos;
    const res = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'GIOSEPPO, S.L.U', cif: 'B03503034' }, numero: 'P-G-2', total_cent: 100,
      lineas: [{ ...LINEAS[0], marca: 'Gioseppo', cantidad: 4 }],
    });
    assert.equal(res.data.entrada.articulos_nuevos, 0);
    const despues = (await admin('GET', '/api/stock/inventario')).data.articulos;
    assert.equal(despues.length, antes.length);
    const sku = despues.find((a) => a.talla === 40);
    assert.equal(sku.codigo, antes.find((a) => a.talla === 40).codigo);
    assert.equal(sku.pendiente, 4);
    assert.equal(sku.stock, 2);
  });

  test('PVP editable y el Asesor no puede recibir mercancía', async () => {
    const art = (await admin('GET', '/api/stock/inventario')).data.articulos[0];
    const pvp = await admin('PUT', `/api/stock/articulos/${art.id}`, { pvp_cent: 4995 });
    assert.equal(pvp.data.pvp_cent, 4995);
    assert.equal((await admin('PUT', `/api/stock/articulos/${art.id}`, { pvp_cent: -1 })).status, 400);

    const users = (await admin('GET', '/api/admin/users')).data;
    await admin('PATCH', `/api/admin/users/${users.find((u) => u.username === 'rperez').id}`, { role: 'asesor' });
    const asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal((await asesor('GET', '/api/stock/inventario')).status, 200);
    const pendiente = (await admin('GET', '/api/stock/entradas')).data[0];
    assert.equal((await asesor('POST', `/api/stock/entradas/${pendiente.id}/recibir`, {})).status, 403);
  });
});
