import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { leerCodigo, leerEuros } from '../src/stock/alta.js';
import { leerExcelAlta, plantillaAlta, valorCelda } from '../src/stock/alta-excel.js';
import { digitoControl, esEan13 } from '../src/stock/barcode.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

// Alta de productos en el inventario sin pedido: uno a uno o desde un Excel.

const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CODIGO_ANTIGUO = '2004567890126'; // un «200…» de las etiquetas de la web antigua
const CODIGO_FABRICA = '8412345678905';

async function excel(filas, { titulos = ['Tipo de producto', 'Fabricante', 'Modelo', 'Referencia', 'Talla', 'Color', 'Precio coste', 'PVP', 'Unidades', 'Código de barras'], antes = [] } = {}) {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Hoja1');
  antes.forEach((f) => hoja.addRow(f));
  hoja.addRow(titulos);
  filas.forEach((f) => hoja.addRow(f));
  return Buffer.from(await libro.xlsx.writeBuffer());
}

/* ---------- Lectores ---------- */

test('precios en euros como se escriben en un Excel', () => {
  assert.deepEqual(leerEuros(22.5), { ok: true, cent: 2250 });
  assert.deepEqual(leerEuros('22,50'), { ok: true, cent: 2250 });
  assert.deepEqual(leerEuros('1.234,50 €'), { ok: true, cent: 123450 });
  assert.deepEqual(leerEuros('19.95'), { ok: true, cent: 1995 });
  assert.deepEqual(leerEuros('1.500'), { ok: true, cent: 150000 }, 'punto de miles sin coma');
  assert.deepEqual(leerEuros(''), { ok: true, cent: null });
  assert.equal(leerEuros('-3').ok, false);
  assert.equal(leerEuros('doce').ok, false);
});

test('código de barras: «200…» propio, de fábrica, el 0 que Excel quita y los no válidos', () => {
  assert.deepEqual(leerCodigo(CODIGO_ANTIGUO), { interno: CODIGO_ANTIGUO });
  assert.deepEqual(leerCodigo(Number(CODIGO_FABRICA)), { fabrica: CODIGO_FABRICA });
  const conCero = `084123456789${digitoControl('084123456789')}`;
  assert.deepEqual(leerCodigo(Number(conCero)), { fabrica: conCero }, 'un EAN-13 que empieza por 0 recupera su 0');
  assert.deepEqual(leerCodigo(''), {});
  assert.match(leerCodigo('2004567890127').error, /no es un EAN-13 válido/);
  assert.match(leerCodigo('ABC').error, /de 8 a 14 cifras/);
});

test('el valor de una celda: fórmulas, texto con formato y enlaces', () => {
  assert.equal(valorCelda({ formula: 'A1*2', result: 4 }), 4);
  assert.equal(valorCelda({ richText: [{ text: 'Pablo' }, { text: 'sky ' }] }), 'Pablosky');
  assert.equal(valorCelda({ text: 'Ref 1', hyperlink: 'http://x' }), 'Ref 1');
  assert.equal(valorCelda(null), '');
});

test('el Excel se lee por sus títulos (en cualquier orden, con o sin tildes) y salta las filas vacías', async () => {
  const buffer = await excel([
    [3, '27', 'Pablosky', '504555', 'marino'],
    [],
    [1, 28.5, 'Pablosky', '504555', 'marino'],
  ], { titulos: ['uds', 'TALLA', 'fabricante', 'Ref', 'Color'], antes: [['Inventario de la tienda'], []] });
  const filas = await leerExcelAlta(buffer);
  assert.equal(filas.length, 2);
  assert.deepEqual(filas[0], { fila: 4, unidades: 3, talla: '27', marca: 'Pablosky', referencia: '504555', color: 'marino' });
  assert.equal(filas[1].fila, 6);
  await assert.rejects(leerExcelAlta(await excel([['a', 'b']], { titulos: ['Nombre', 'Precio'] })), /títulos/);
  await assert.rejects(leerExcelAlta(Buffer.from('a,b\n1,2')), /no es un Excel .xlsx/);
});

test('la plantilla trae los títulos que luego se leen y los ejemplos aparte', async () => {
  const buffer = await plantillaAlta([{ type: 'calzado', name: 'Botas' }]);
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  assert.deepEqual(libro.worksheets.map((h) => h.name), ['Productos', 'Instrucciones']);
  const titulos = libro.getWorksheet('Productos').getRow(1).values.slice(1);
  assert.deepEqual(titulos.slice(0, 10), ['Tipo de producto', 'Fabricante', 'Modelo', 'Referencia', 'Talla', 'Color', 'Precio coste', 'PVP', 'Unidades', 'Código de barras']);
  assert.equal(libro.getWorksheet('Productos').getRow(2).values.length, 0, 'la hoja de productos va vacía: los ejemplos no se importan');
  await assert.rejects(leerExcelAlta(buffer), /no tiene productos/);
});

/* ---------- API ---------- */

describe('API de alta de inventario', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
  after(async () => {
    await ctx?.stop();
  });

  const subirExcel = async (buffer) => {
    const res = await admin.raw('POST', '/api/stock/alta/excel', { body: buffer, headers: { 'Content-Type': EXCEL } });
    return { status: res.status, ...(await res.json()) };
  };
  const inventario = async (q) => (await admin('GET', `/api/stock/inventario?q=${encodeURIComponent(q)}`)).data.articulos;

  test('alta manual: crea el producto con su código y las unidades en stock', async () => {
    const fila = { tipo: 'calzado', marca: 'Pablosky', modelo: 'Bota cremallera', referencia: '504555', talla: '27', color: 'Marino', coste: '22,50', pvp: '45,95', unidades: 2 };
    const rev = await admin('POST', '/api/stock/alta/revisar', { filas: [fila] });
    assert.equal(rev.status, 200);
    assert.deepEqual(rev.data.resumen, { nuevos: 1, sumar: 0, conflictos: 0, unidades: 2 });
    assert.equal(rev.data.lineas[0].estado, 'nuevo');
    assert.equal((await inventario('504555')).length, 0, 'revisar no cambia nada');

    const ok = await admin('POST', '/api/stock/alta/confirmar', { filas: [fila] });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.data.resumen, { nuevos: 1, sumados: 0, actualizados: 0, omitidos: 0, unidades: 2 });
    const [a] = await inventario('504555');
    assert.match(a.codigo, /^200\d{10}$/);
    assert.ok(esEan13(a.codigo));
    assert.equal(a.stock, 2);
    assert.equal(a.pvp_cent, 4595);
    assert.equal(a.coste_cent, 2250);
    assert.equal(ok.data.articulos[0].id, a.id);
  });

  test('el mismo producto con los mismos datos suma unidades; con otros datos pregunta', async () => {
    const base = { tipo: 'Calzado', marca: 'pablosky', modelo: 'bota cremallera', referencia: '504555', talla: 27, color: 'marino', pvp: 45.95, unidades: 3 };
    const igual = await admin('POST', '/api/stock/alta/confirmar', { filas: [base] });
    assert.equal(igual.data.resumen.sumados, 1);
    assert.equal((await inventario('504555'))[0].stock, 5);

    const distinto = { ...base, pvp: '49,95', unidades: 1 };
    const rev = await admin('POST', '/api/stock/alta/revisar', { filas: [distinto] });
    const [l] = rev.data.lineas;
    assert.equal(l.estado, 'conflicto');
    assert.equal(l.stock_actual, 5);
    assert.deepEqual(l.diferencias, [{ campo: 'pvp', etiqueta: 'PVP', actual: '45,95 €', nuevo: '49,95 €' }]);

    const sinDecidir = await admin('POST', '/api/stock/alta/confirmar', { filas: [distinto] });
    assert.equal(sinDecidir.status, 409);
    assert.equal(sinDecidir.code, 'DECISION_REQUIRED');
    assert.equal(sinDecidir.data.lineas[0].estado, 'conflicto');
    assert.equal((await inventario('504555'))[0].stock, 5, 'sin decidir no se aplica nada');

    await admin('POST', '/api/stock/alta/confirmar', { filas: [distinto], decisiones: { [l.clave]: 'mantener' } });
    let [a] = await inventario('504555');
    assert.equal(a.stock, 6);
    assert.equal(a.pvp_cent, 4595, 'mantener: suma las unidades y deja el PVP');

    await admin('POST', '/api/stock/alta/confirmar', { filas: [distinto], decisiones: { [l.clave]: 'actualizar' } });
    [a] = await inventario('504555');
    assert.equal(a.stock, 7);
    assert.equal(a.pvp_cent, 4995, 'actualizar: suma y cambia el PVP');

    await admin('POST', '/api/stock/alta/confirmar', { filas: [{ ...distinto, pvp: '1' }], decisiones: { [l.clave]: 'omitir' } });
    assert.equal((await inventario('504555'))[0].stock, 7, 'omitir no toca el artículo');
  });

  test('un dato vacío no cuenta como distinto: completa el que faltaba', async () => {
    await admin('POST', '/api/stock/alta/confirmar', { filas: [{ marca: 'Victoria', referencia: '1065101', talla: '30', color: 'Blanco', unidades: 1 }] });
    const rev = await admin('POST', '/api/stock/alta/revisar', { filas: [{ marca: 'Victoria', referencia: '1065101', talla: '30', color: 'Blanco', unidades: 2, pvp: '35', coste: '' }] });
    assert.equal(rev.data.lineas[0].estado, 'sumar');
    await admin('POST', '/api/stock/alta/confirmar', { filas: [{ marca: 'Victoria', referencia: '1065101', talla: '30', color: 'Blanco', unidades: 2, pvp: '35' }] });
    const [a] = await inventario('1065101');
    assert.equal(a.stock, 3);
    assert.equal(a.pvp_cent, 3500);
    assert.equal(a.tipo, 'calzado', 'sin tipo, una talla de pie es calzado');
  });

  test('sin modelo vale el producto que ya existe con esa referencia (no se duplica)', async () => {
    const rev = await admin('POST', '/api/stock/alta/revisar', { filas: [{ marca: 'Pablosky', referencia: '504555', talla: '27', color: 'Marino', unidades: 1 }] });
    assert.equal(rev.data.lineas[0].estado, 'sumar');
    assert.equal(rev.data.lineas[0].modelo, 'Bota cremallera');
    const antes = (await inventario('504555')).length;
    await admin('POST', '/api/stock/alta/confirmar', { filas: [{ marca: 'Pablosky', referencia: '504555', talla: '27', color: 'Marino', unidades: 1 }] });
    const despues = await inventario('504555');
    assert.equal(despues.length, antes, 'no crea otro artículo');
    assert.equal(despues[0].stock, 8);
    await admin('POST', '/api/stock/alta/confirmar', { filas: [{ marca: 'Pablosky', modelo: 'Otro modelo', referencia: '504555', talla: '27', color: 'Marino', unidades: 1 }] });
    const ambiguo = await admin('POST', '/api/stock/alta/revisar', { filas: [{ marca: 'Pablosky', referencia: '504555', talla: '27', color: 'Marino', unidades: 1 }] });
    assert.match(ambiguo.data.errores[0].errores[0], /hay 2 modelos con la referencia 504555/);
  });

  test('códigos de barras: el «200…» antiguo se conserva, el de fábrica también escanea, y no se repiten', async () => {
    const res = await admin('POST', '/api/stock/alta/confirmar', {
      filas: [
        { tipo: 'calzado', marca: 'Garvalín', referencia: '231300', talla: '24', color: 'Rosa', unidades: 1, codigo: CODIGO_ANTIGUO },
        { tipo: 'ropa', marca: 'Marca', modelo: 'Pijama', referencia: 'PJ-200', talla: '4 años', color: 'Gris', unidades: 2, codigo: CODIGO_FABRICA },
      ],
    });
    assert.equal(res.status, 201);
    const [garvalin] = await inventario('231300');
    assert.equal(garvalin.codigo, CODIGO_ANTIGUO);
    const [pijama] = await inventario('PJ-200');
    assert.equal(pijama.talla, '4A');
    assert.equal(pijama.codigo_fabricante, CODIGO_FABRICA);
    assert.match(pijama.codigo, /^200/);
    const escaneo = await admin('GET', `/api/tpv/buscar?q=${CODIGO_FABRICA}`);
    assert.equal(escaneo.data.exacto.id, pijama.id, 'el TPV lo encuentra por el código de la caja');

    const repetido = await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'juguetes', marca: 'X', referencia: 'YY', unidades: 1, codigo: CODIGO_ANTIGUO }] });
    assert.equal(repetido.data.lineas.length, 0);
    assert.match(repetido.data.errores[0].errores[0], /ya es de otro artículo \(Garvalín 231300 Rosa T\. 24\)/);
    const otroCodigo = await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'calzado', marca: 'Garvalín', referencia: '231300', talla: '24', color: 'Rosa', unidades: 1, codigo: '2001111111119' }] });
    assert.match(otroCodigo.data.errores[0].errores[0], /ya existe con el código 2004567890126/);
  });

  test('Excel: errores por fila con su número; con errores no se importa nada', async () => {
    const buffer = await excel([
      ['Calzado', 'Lejan', 'Zapato', 'L-1', '31', 'Azul', '20', '39,95', 2, ''],
      ['Calzado', 'Lejan', 'Zapato', 'L-1', 'M', 'Azul', '20', '39,95', 1, ''],
      ['Juguetes', 'Djeco', 'Puzle', 'DJ-7', '', '', '8', '14,90', 'dos', ''],
      ['Bicicletas', 'X', 'Y', 'Z', '', '', '', '', 1, ''],
    ]);
    const res = await subirExcel(buffer);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.revision.errores.map((e) => e.fila), [3, 4, 5]);
    assert.match(res.data.revision.errores[0].errores[0], /talla «M» no válida para calzado/);
    assert.match(res.data.revision.errores[1].errores[0], /unidades no válidas/);
    assert.match(res.data.revision.errores[2].errores[0], /tipo «Bicicletas» no válido/);
    const ko = await admin('POST', '/api/stock/alta/confirmar', { filas: res.data.filas, origen: 'excel' });
    assert.equal(ko.status, 400);
    assert.equal(ko.code, 'ROWS_INVALID');
    assert.equal((await inventario('L-1')).length, 0);
  });

  test('Excel: filas repetidas se juntan; un mismo producto con otros datos es un error', async () => {
    const res = await subirExcel(await excel([
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 31, 'Azul', 20, 39.95, 2, ''],
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 31, 'Azul', 20, 39.95, 1, ''],
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 32, 'Azul', 20, 39.95, 1, ''],
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 32, 'Azul', 20, 42, 1, ''],
    ]));
    assert.deepEqual(res.data.revision.errores.map((e) => e.fila), [5]);
    assert.match(res.data.revision.errores[0].errores[0], /mismo producto que la fila 4/);
    const ok = await subirExcel(await excel([
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 31, 'Azul', 20, 39.95, 2, ''],
      ['Calzado', 'Lejan', 'Zapato', 'L-2', 31, 'Azul', 20, 39.95, 1, ''],
      ['Accesorios', 'Tutete', 'Mochila', 'MO-1', '', 'Verde', 12, 24.9, 4, ''],
    ]));
    assert.deepEqual(ok.data.revision.resumen, { nuevos: 2, sumar: 0, conflictos: 0, unidades: 7 });
    assert.deepEqual(ok.data.revision.lineas[0].filas, [2, 3]);
    const hecho = await admin('POST', '/api/stock/alta/confirmar', { filas: ok.data.filas, origen: 'excel' });
    assert.equal(hecho.status, 201);
    assert.equal((await inventario('L-2'))[0].stock, 3);
    assert.equal((await inventario('MO-1'))[0].talla, 'Única');

    const pdf = await admin.raw('POST', '/api/stock/alta/etiquetas.pdf', {
      body: JSON.stringify({ articulos: hecho.data.articulos.map((a) => ({ id: a.id, copias: a.unidades })) }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(pdf.status, 200);
    const texto = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    assert.equal((texto.match(/\/Type \/Page /g) ?? []).length, 7, 'una etiqueta por unidad');

    const log = await admin('GET', '/api/admin/log?area=stock');
    assert.equal(log.status, 200);
    const entrada = log.data.items.find((e) => e.target === 'Inventario desde Excel' && e.field === 'Unidades');
    assert.equal(entrada?.newValue, '7');
  });

  test('cambiar el tipo de un producto que ya existe se pregunta, y su talla tiene que valer', async () => {
    const rev = await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'ropa', marca: 'Tutete', modelo: 'Mochila', referencia: 'MO-1', color: 'Verde', unidades: 1 }] });
    assert.equal(rev.data.lineas[0].estado, 'conflicto');
    assert.equal(rev.data.lineas[0].diferencias[0].campo, 'tipo');
    const imposible = await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'juguetes', marca: 'Lejan', modelo: 'Zapato', referencia: 'L-2', talla: '31', color: 'Azul', unidades: 1 }] });
    assert.ok(imposible.data.errores.length, 'una talla 31 no vale para un juguete');
  });

  test('el Asesor no da de alta; los límites se respetan', async () => {
    const users = (await admin('GET', '/api/admin/users')).data;
    await admin('PATCH', `/api/admin/users/${users.find((u) => u.username === 'rperez').id}`, { role: 'asesor' });
    const asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    assert.equal((await asesor('POST', '/api/stock/alta/confirmar', { filas: [{ marca: 'A', referencia: 'B', talla: '30', color: 'C', unidades: 1 }] })).status, 403);
    const plantilla = await asesor.raw('GET', '/api/stock/alta/plantilla.xlsx');
    assert.equal(plantilla.status, 200);
    assert.match(plantilla.headers.get('content-type'), /spreadsheetml/);
    assert.equal((await admin('POST', '/api/stock/alta/revisar', { filas: [] })).status, 400);
    const muchas = Array.from({ length: 2001 }, (_, i) => ({ marca: 'A', referencia: `R${i}`, talla: '30', color: 'C', unidades: 1 }));
    assert.equal((await admin('POST', '/api/stock/alta/revisar', { filas: muchas })).code, 'TOO_MANY_ROWS');
    const sinSesion = await ctx.client()('POST', '/api/stock/alta/revisar', { filas: [{}] });
    assert.equal(sinSesion.status, 401);
  });
});
