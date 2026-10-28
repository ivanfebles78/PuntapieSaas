import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from '../src/proveedores/extract/pdfText.js';
import { lineasFactura, lineasPedido } from '../src/proveedores/parsers/gioseppo.js';
import { parseDocumento } from '../src/proveedores/parsers/index.js';
import { lineasLejan } from '../src/proveedores/parsers/lejan.js';
import { filasDeTramo } from '../src/proveedores/parsers/lineas.js';
import { colorSimple, esPropuesta, lineasPropuesta } from '../src/proveedores/parsers/pablosky.js';
import { digitoControl, esEan13, nuevoCodigo } from '../src/stock/barcode.js';
import { ETIQUETA, generarEtiquetasPdf, modulosEan13 } from '../src/stock/pdf/etiquetas.js';
import { validarLineas } from '../src/stock/repo.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, fixtureBytes, HAY_FIXTURES, SIN_FIXTURES } from './proveedores-fixtures.js';

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

test('Lejan: tallas arriba y pares debajo, por columnas; el nombre puede ocupar dos líneas', () => {
  const fila = (celdas) => ({ items: celdas.map(([x, s]) => ({ x, s })), text: celdas.map(([, s]) => s).join(' ') });
  const lines = [
    fila([[96, 'MODELO'], [193, 'TALLAS'], [370, 'Pares'], [404, 'Precio par']]),
    fila([[46, 'Pedido 101066 · Albarán 113522 — September 9, 2026']]),
    fila([[193, '37'], [207, '38'], [222, '39']]),
    fila([[96, 'Lejan Melrose® - Dark']]),
    fila([[96, 'Brown'], [193, '1'], [222, '2']]),
    fila([[370, '3'], [404, '52.00'], [492, '156.00']]),
    fila([[96, 'LEJA-RETROB-RO']]),
    fila([[96, 'Ref. 1950']]),
    fila([[46, 'Vencimiento November 22, 2026 Total pares 3']]),
  ];
  assert.deepEqual(lineasLejan(lines), [
    { marca: 'Lejan', referencia: '1950', modelo: 'Melrose', color: 'Dark Brown', talla: 37, cantidad: 1, coste_cent: 5200, pvp_cent: null },
    { marca: 'Lejan', referencia: '1950', modelo: 'Melrose', color: 'Dark Brown', talla: 39, cantidad: 2, coste_cent: 5200, pvp_cent: null },
  ]);
});

test('Lejan, facturas reales: los pares leídos cuadran con «Total pares»', SIN_FIXTURES, async () => {
  const d = parseDocumento(await extractPdfText(fixtureBytes('lejan/Lejan-F2617638.pdf')));
  assert.deepEqual(d.lineas.map((l) => [l.referencia, l.modelo, l.color, l.talla, l.cantidad]), [['1986', 'Sakura', 'Skyblue', 38, 1], ['1989', 'Sakura', 'Dusty Pink', 38, 1]]);
  for (const f of ['lejan/c0a75fc6fb8e4318b0131e6426aac2be.pdf', 'lejan/pagadas/d7dab03af1c54571bf848093830865ea.pdf']) {
    const x = parseDocumento(await extractPdfText(fixtureBytes(f)));
    assert.ok(x.lineas.length > 0, f);
    assert.deepEqual(x.avisos, [], f);
  }
});

test('un tramo sin desglose da una fila por talla a repartir (o la cantidad si es de una sola talla)', () => {
  const base = { marca: 'Garvalín', referencia: '261105', modelo: 'Botin', color: 'Latte', coste_cent: 2450, pvp_cent: null };
  const filas = filasDeTramo(base, { desde: 18, hasta: 20, total: 5, id: 'g1' });
  assert.deepEqual(filas.map((f) => [f.talla, f.cantidad, f.tramo.total]), [[18, 0, 5], [19, 0, 5], [20, 0, 5]]);
  assert.deepEqual(filasDeTramo(base, { desde: 36, hasta: 36, total: 2, id: 'g2' }).map((f) => [f.talla, f.cantidad, f.tramo]), [[36, 2, undefined]]);
});

test('el resto de proveedores, con sus PDF reales: las unidades cuadran con el total del documento', SIN_FIXTURES, async () => {
  const leer = async (f) => parseDocumento(await extractPdfText(fixtureBytes(f)));
  const suma = (d) => d.lineas.reduce((s, l) => s + l.cantidad, 0);
  const enTramos = (d) => [...new Map(d.lineas.filter((l) => l.tramo).map((l) => [l.tramo.id, l.tramo.total])).values()].reduce((a, b) => a + b, 0);
  // Por tramos (a repartir): Garvalín 188 pares menos 9 expositores a 0 €, Titanitos 45, Pablosky 64.
  assert.equal(enTramos(await leer('Garvalin/2613709 (2).pdf')), 179);
  const titanitos = await leer('titanitos/Factura de clientes_2502572_20251016_213053 (1).pdf');
  assert.equal(enTramos(titanitos) + suma(titanitos), 45);
  assert.ok(titanitos.lineas.some((l) => l.modelo === 'Susana' && l.color === 'Combinado 1'));
  assert.equal(enTramos(await leer('pablosky/Factura 2520059.pdf')), 64);
  // Talla a talla.
  const condor = await leer('condor/factura-500047.pdf');
  assert.equal(suma(condor), 243);
  assert.ok(condor.lineas.every((l) => !l.tramo) && condor.lineas.some((l) => l.modelo === 'Calcetines altos básicos canalé' && l.talla === 4));
  assert.equal(suma(await leer('etika/pedido-2600412.pdf')), 160);
  const victoria = await leer('victoria/pedido-5501945-confirmacion.pdf');
  assert.equal(suma(victoria), 153);
  assert.ok(victoria.lineas.some((l) => l.referencia === '9126256' && l.talla === 0), 'talla única = sin talla');
});

test('Vulladi: serie = tallas; si los pares cuadran va 1 de cada, si no se reparte a mano', async () => {
  const { lineasVulladi } = await import('../src/proveedores/parsers/vulladi.js');
  const ls = lineasVulladi(['1198-406 28/30 SUEDE MARINO 3 19,57 58,71', '1190-406 35/41 SUEDE NEGRO 8 18,85 150,80']);
  assert.deepEqual(ls.slice(0, 3).map((l) => [l.talla, l.cantidad, l.color, l.coste_cent]), [[28, 1, 'Suede Marino', 1957], [29, 1, 'Suede Marino', 1957], [30, 1, 'Suede Marino', 1957]]);
  const negro = ls.filter((l) => l.color === 'Suede Negro');
  assert.equal(negro.length, 7);
  assert.ok(negro.every((l) => l.cantidad === 0 && l.tramo.total === 8));
});

test('Vulladi, factura real: cabecera, vencimientos y los 104 pares', { skip: !fs.existsSync(path.join(FIXTURES, 'vulladi')) && 'sin el PDF de Vulladi' }, async () => {
  const d = parseDocumento(await extractPdfText(fixtureBytes('vulladi/factura-17788.pdf')));
  assert.equal(d.parser, 'vulladi');
  assert.deepEqual([d.numero, d.fecha, d.total_cent, d.confianza], ['17788', '2026-10-15', 178596, 'alta']);
  assert.deepEqual(d.vencimientos.map((v) => [v.fecha, v.importe_cent]), [['2026-11-14', 59532], ['2026-12-14', 59532], ['2027-01-13', 59532]]);
  const directos = d.lineas.filter((l) => !l.tramo).reduce((s, l) => s + l.cantidad, 0);
  const tramos = [...new Map(d.lineas.filter((l) => l.tramo).map((l) => [l.tramo.id, l.tramo.total])).values()];
  assert.equal(directos + tramos.reduce((a, b) => a + b, 0), 104);
  assert.equal(tramos.length, 11);
  assert.ok(d.lineas.some((l) => l.referencia === '1198-411' && l.color === 'Leopardo Irisado-Beig'));
});

test('Victoria, factura real: serie = tallas, color partido en dos líneas y los 152 pares', { skip: !fs.existsSync(path.join(FIXTURES, 'victoria/factura-26FV23615.pdf')) && 'sin la factura de Victoria' }, async () => {
  const d = parseDocumento(await extractPdfText(fixtureBytes('victoria/factura-26FV23615.pdf')));
  assert.deepEqual([d.tipo, d.numero, d.fecha, d.total_cent, d.confianza], ['factura', '26FV23615', '2026-10-20', 385280, 'alta']);
  assert.deepEqual(d.pedidos, ['5501945']);
  assert.deepEqual(d.vencimientos, [{ fecha: '2026-10-20', importe_cent: 385280 }]);
  const directos = d.lineas.filter((l) => !l.tramo).reduce((s, l) => s + l.cantidad, 0);
  const tramos = [...new Map(d.lineas.filter((l) => l.tramo).map((l) => [l.tramo.id, l.tramo.total])).values()];
  assert.equal(directos + tramos.reduce((a, b) => a + b, 0), 152);
  // 22/28 con 7 pares cuadra (1 de cada talla); 28/35 con 6 pares se reparte a mano.
  const kai = d.lineas.filter((l) => l.referencia === '1172102' && l.color === 'Botella' && l.talla <= 28);
  assert.deepEqual(kai.map((l) => [l.talla, l.cantidad]), [22, 23, 24, 25, 26, 27, 28].map((t) => [t, 1]));
  const tiempo = d.lineas.filter((l) => l.referencia === '1124131');
  assert.ok(tiempo.length === 8 && tiempo.every((l) => l.tramo?.total === 6 && l.color === 'Beige'));
  assert.ok(d.lineas.some((l) => l.referencia === '1080117' && l.color === 'Leopardo'), 'LEOPARD + O = Leopardo');
  assert.ok(d.lineas.some((l) => l.referencia === '9126256' && l.talla === 0 && l.cantidad === 1), 'UNICA = sin talla');
});

test('validarLineas junta el mismo SKU y rechaza datos imposibles', () => {
  const l = { marca: 'Gioseppo', referencia: '1', color: 'Rosa', talla: 30, cantidad: 2 };
  const v = validarLineas([l, { ...l, cantidad: 3, pvp_cent: 3995 }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].cantidad, 5);
  assert.equal(v[0].modelo, '1', 'sin modelo, se usa la referencia');
  assert.equal(v[0].pvp_cent, 3995);
  assert.deepEqual(validarLineas([{ ...l, cantidad: 0 }]), [], 'una talla sin unidades no se da de alta');
  assert.throws(() => validarLineas([{ ...l, cantidad: -1 }]), /cantidad/);
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

  test('un documento ya guardado sin productos los lee de su PDF y los da de alta', { skip: !HAY_FIXTURES && 'sin PDFs reales' }, async () => {
    const bytes = fixtureBytes('lejan/Lejan-F2617638.pdf');
    const an = await (await admin.raw('POST', '/api/proveedores/analizar', { body: bytes, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'Lejan-F2617638.pdf' } })).json();
    const e = an.data.extraido;
    // Se guarda como antes del lector de Lejan: sin productos.
    const doc = (await admin('POST', '/api/proveedores/documentos', { tempId: an.data.tempId, tipo: e.tipo, proveedor: e.proveedor, numero: e.numero, fecha: e.fecha, total_cent: e.total_cent, vencimientos: e.vencimientos })).data;
    assert.equal(doc.entrada.unidades, 0);
    const leido = await admin('GET', `/api/stock/entradas/${doc.id}/leer`);
    assert.equal(leido.data.lineas.length, 2);
    const alta = await admin('POST', `/api/stock/entradas/${doc.id}`, { lineas: leido.data.lineas, marca: 'Lejan' });
    assert.equal(alta.status, 201);
    assert.equal(alta.data.totales.pendientes, 2);
    assert.equal((await admin('POST', `/api/stock/entradas/${doc.id}`, { lineas: leido.data.lineas })).code, 'LINES_EXIST');
    assert.equal((await admin('GET', `/api/stock/entradas/${doc.id}/leer`)).code, 'LINES_EXIST', 'si ya los tiene, avisa en vez de ofrecer leerlos'); 
  });

  test('al revés también: el pedido de una factura que ya tiene productos no los duplica', async () => {
    const factura = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'factura', proveedor: { nombre: 'Lejan', cif: 'B44612695' }, numero: 'F-L-1', fecha: '2026-10-20', total_cent: 5200,
      pedidos: ['126318'], vencimientos: [{ fecha: '2026-11-20', importe_cent: 5200 }],
      lineas: [{ marca: 'Lejan', referencia: '1986', modelo: 'Sakura', color: 'Skyblue', talla: 38, cantidad: 1 }],
    });
    assert.equal(factura.data.entrada.unidades, 1);
    const pedido = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Lejan', cif: 'B44612695' }, numero: '126318', total_cent: 5200,
      lineas: [{ marca: 'Lejan', referencia: '1986', modelo: 'Sakura', color: 'Skyblue', talla: 38, cantidad: 1 }],
    });
    assert.equal(pedido.data.entrada.unidades, 0);
    assert.deepEqual(pedido.data.entrada.omitido, { id: factura.data.id, tipo: 'factura', numero: 'F-L-1' });
    const alta = await admin('POST', `/api/stock/entradas/${pedido.data.id}`, { lineas: [{ marca: 'Lejan', referencia: '1', color: 'Rosa', talla: 30, cantidad: 1 }] });
    assert.equal(alta.code, 'LINES_IN_LINKED_DOC');
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
