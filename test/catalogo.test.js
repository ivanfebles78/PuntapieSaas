import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from '../src/db/migrate.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

// Admin › Catálogo: tipos (con sus tallas), subtipos y fabricantes, y cómo el
// alta de productos los usa.

describe('Catálogo de productos', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let empleado;

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    empleado = await ctx.loginAs('epena', 'Test1234');
    await empleado('POST', '/api/auth/change-password', { newPassword: 'Empleada2026x', confirmPassword: 'Empleada2026x' });
  });
  after(async () => {
    await ctx?.stop();
  });

  const catalogo = async () => (await admin('GET', '/api/stock/catalogo')).data;
  const alta = (fila) => admin('POST', '/api/stock/alta/confirmar', { filas: [{ unidades: 1, ...fila }], origen: 'manual' });
  const marca = async (n) => (await catalogo()).marcas.find((m) => m.nombre.toLowerCase() === n.toLowerCase());
  const subtipo = async (tipo, n) => (await catalogo()).tipos.find((t) => t.id === tipo).subtipos.find((s) => s.nombre === n);

  test('trae los cuatro tipos de siempre con sus tallas y subtipos', async () => {
    const c = await catalogo();
    assert.deepEqual(c.tipos.map((t) => t.id), ['calzado', 'ropa', 'accesorios', 'juguetes']);
    assert.deepEqual(c.tipos[0].tallas, ['numero']);
    assert.equal(c.tipos[3].color, false);
    assert.ok(c.tipos[0].subtipos.some((s) => s.nombre === 'Botas'));
    assert.ok(c.clases.some((x) => x.id === 'unica'));
  });

  test('los fabricantes que ya están en el inventario entran solos al arrancar, con sus tipos', async () => {
    await ctx.pool.query(`INSERT INTO inventory_items (brand, model, reference, color, size, barcode, type)
                          VALUES ('Antigua', 'M', 'R-1', 'Rojo', '27', '2000000000017', 'calzado'),
                                 ('ANTIGUA', 'M', 'R-2', 'Rojo', 'M', '2000000000024', 'ropa')`);
    await applySchema(ctx.pool);
    const m = await marca('Antigua');
    assert.ok(m, 'una sola entrada aunque esté escrita de dos formas');
    assert.deepEqual(m.ambitos.map((a) => a.tipo).sort(), ['calzado', 'ropa']);
    assert.equal(m.productos, 2);
    await applySchema(ctx.pool);
    assert.equal((await catalogo()).marcas.filter((x) => x.nombre.toLowerCase() === 'antigua').length, 1, 'arrancar otra vez no duplica');
  });

  test('lo borrado o renombrado en el catálogo no vuelve al arrancar', async () => {
    const paraguas = await subtipo('accesorios', 'Paraguas');
    assert.equal((await admin('DELETE', `/api/stock/catalogo/subtipos/${paraguas.id}`)).status, 200);
    assert.equal((await admin('PUT', '/api/stock/catalogo/tipos/juguetes', { nombre: 'Juegos', tallas: ['unica'], color: false })).status, 200);
    await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'Juguetes', tallas: ['unica'] }); // otro tipo con el nombre antiguo
    await applySchema(ctx.pool);
    const c = await catalogo();
    assert.equal(await subtipo('accesorios', 'Paraguas'), undefined, 'el subtipo borrado no vuelve');
    assert.equal(c.tipos.find((t) => t.id === 'juguetes').nombre, 'Juegos', 'el nombre cambiado se queda');
    // Se deja como estaba para el resto de pruebas.
    assert.equal((await admin('DELETE', '/api/stock/catalogo/tipos/juguetes-2')).status, 200);
    assert.equal((await admin('PUT', '/api/stock/catalogo/tipos/juguetes', { nombre: 'Juguetes', tallas: ['unica'], color: false })).status, 200);
  });

  test('un tipo nuevo vale para dar de alta con sus tallas; cambiarlo no puede dejar productos inválidos', async () => {
    const nuevo = await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'Bolsos y mochilas', tallas: ['unica'], color: false });
    assert.equal(nuevo.status, 201);
    assert.equal(nuevo.data.resultado.id, 'bolsos-y-mochilas');
    assert.equal((await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'bolsos Y mochilas', tallas: ['unica'] })).code, 'DUPLICATE');
    assert.equal((await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'X', tallas: ['inventada'] })).status, 400);
    assert.equal((await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'X', tallas: [] })).status, 400);

    const ok = await alta({ tipo: 'bolsos-y-mochilas', marca: 'Bolsera', referencia: 'B-1', talla: '' });
    assert.equal(ok.status, 201, ok.error);
    const mal = await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'bolsos-y-mochilas', marca: 'Bolsera', referencia: 'B-2', talla: '27', unidades: 1 }] });
    assert.ok(mal.data.errores.length, 'un número de pie no vale para ese tipo');

    // Con productos de talla única, quitar «talla única» no se puede; pedir color, tampoco (no tienen).
    const sinUnica = await admin('PUT', '/api/stock/catalogo/tipos/bolsos-y-mochilas', { nombre: 'Bolsos', tallas: ['letra'], color: false });
    assert.equal(sinUnica.code, 'SIZES_IN_USE');
    const conColor = await admin('PUT', '/api/stock/catalogo/tipos/bolsos-y-mochilas', { nombre: 'Bolsos', tallas: ['unica'], color: true });
    assert.equal(conColor.code, 'COLOR_MISSING');
    const renombrado = await admin('PUT', '/api/stock/catalogo/tipos/bolsos-y-mochilas', { nombre: 'Bolsos', tallas: ['unica', 'letra'], color: false });
    assert.equal(renombrado.status, 200, renombrado.error);
    const t = renombrado.data.catalogo.tipos.find((x) => x.id === 'bolsos-y-mochilas');
    assert.equal(t.nombre, 'Bolsos');
    assert.deepEqual(t.tallas, ['unica', 'letra']);
    assert.ok((await admin('GET', '/api/stock/tipos')).data.some((x) => x.nombre === 'Bolsos'), 'el formulario ve el nombre nuevo');

    // Con productos no se borra; sin ellos, sí (y sus subtipos con él).
    assert.equal((await admin('DELETE', '/api/stock/catalogo/tipos/bolsos-y-mochilas')).code, 'IN_USE');
    await admin('POST', '/api/stock/catalogo/tipos', { nombre: 'Temporal', tallas: ['unica'] });
    await admin('POST', '/api/stock/catalogo/subtipos', { tipo: 'temporal', nombre: 'Algo' });
    const borrado = await admin('DELETE', '/api/stock/catalogo/tipos/temporal');
    assert.equal(borrado.status, 200, borrado.error);
    assert.ok(!borrado.data.catalogo.tipos.some((x) => x.id === 'temporal'));
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM product_subtypes WHERE type = 'temporal'")).rows[0].n, 0);
    assert.equal((await admin('POST', '/api/stock/alta/revisar', { filas: [{ tipo: 'temporal', marca: 'A', referencia: 'B', unidades: 1 }] })).data.errores.length, 1);
  });

  test('subtipos: alta, nombre repetido, renombrar y borrar (sus productos se quedan sin subtipo)', async () => {
    const s = await admin('POST', '/api/stock/catalogo/subtipos', { tipo: 'calzado', nombre: 'Zuecos' });
    assert.equal(s.status, 201);
    assert.equal((await admin('POST', '/api/stock/catalogo/subtipos', { tipo: 'calzado', nombre: 'Zuecos' })).code, 'DUPLICATE');
    assert.equal((await admin('POST', '/api/stock/catalogo/subtipos', { tipo: 'calzado', nombre: 'zuecos' })).code, 'DUPLICATE', 'sin distinguir mayúsculas');
    assert.equal((await admin('POST', '/api/stock/catalogo/subtipos', { tipo: 'inventado', nombre: 'X' })).status, 400);
    const id = s.data.resultado.id;
    assert.equal((await admin('PUT', `/api/stock/catalogo/subtipos/${id}`, { nombre: 'Zuecos y clogs' })).status, 200);
    assert.equal((await alta({ tipo: 'calzado', subtipo: 'Zuecos y clogs', marca: 'Zuequera', referencia: 'Z-1', talla: '30', color: 'Verde' })).status, 201);
    // Un fabricante que solo tenía ese subtipo pasa a todo el calzado.
    const m = await admin('POST', '/api/stock/catalogo/marcas', { nombre: 'SoloZuecos', ambitos: [{ tipo: 'calzado', subtipo_id: id }] });
    assert.equal(m.status, 201, m.error);
    const borrado = await admin('DELETE', `/api/stock/catalogo/subtipos/${id}`);
    assert.equal(borrado.status, 200);
    assert.equal(borrado.data.resultado.productos, 1);
    const [art] = (await admin('GET', '/api/stock/inventario?q=Z-1')).data.articulos;
    assert.equal(art.subtipo_id, null);
    assert.deepEqual((await marca('SoloZuecos')).ambitos, [{ tipo: 'calzado', subtipo_id: null }]);
  });

  test('fabricantes: ámbitos por tipo y subtipo, renombrar también en el inventario, y no se borran con productos', async () => {
    const botas = await subtipo('calzado', 'Botas');
    const pijamas = await subtipo('ropa', 'Pijamas');
    const r = await admin('POST', '/api/stock/catalogo/marcas', {
      nombre: 'Botitas', ambitos: [{ tipo: 'calzado', subtipo_id: botas.id }, { tipo: 'ropa' }, { tipo: 'ropa', subtipo_id: pijamas.id }],
    });
    assert.equal(r.status, 201, r.error);
    assert.deepEqual(r.data.resultado.ambitos, [{ tipo: 'ropa', subtipo_id: null }, { tipo: 'calzado', subtipo_id: botas.id }], 'todo un tipo absorbe sus subtipos');
    assert.equal((await admin('POST', '/api/stock/catalogo/marcas', { nombre: 'BOTITAS' })).code, 'DUPLICATE');
    assert.equal((await admin('POST', '/api/stock/catalogo/marcas', { nombre: 'Otra', ambitos: [{ tipo: 'ropa', subtipo_id: botas.id }] })).status, 400, 'un subtipo de otro tipo');
    assert.equal((await admin('POST', '/api/stock/catalogo/marcas', { nombre: '   ' })).status, 400);

    await alta({ tipo: 'calzado', subtipo: 'Botas', marca: 'Botitas', referencia: 'BT-1', talla: '25', color: 'Negro' });
    await alta({ tipo: 'calzado', subtipo: 'Botas', marca: 'botitas', referencia: 'BT-2', talla: '26', color: 'Negro' });
    const id = r.data.resultado.id;
    const cambio = await admin('PUT', `/api/stock/catalogo/marcas/${id}`, { nombre: 'Botitas Kids', ambitos: [] });
    assert.equal(cambio.status, 200, cambio.error);
    assert.equal(cambio.data.resultado.renombrados, 2);
    const arts = (await admin('GET', '/api/stock/inventario?q=BT-')).data.articulos;
    assert.deepEqual(arts.map((a) => a.marca), ['Botitas Kids', 'Botitas Kids']);
    assert.deepEqual((await marca('Botitas Kids')).ambitos, [], 'sin ámbitos = todos los tipos');

    assert.equal((await admin('DELETE', `/api/stock/catalogo/marcas/${id}`)).code, 'IN_USE');
    const libre = await admin('POST', '/api/stock/catalogo/marcas', { nombre: 'Sin productos' });
    assert.equal((await admin('DELETE', `/api/stock/catalogo/marcas/${libre.data.resultado.id}`)).status, 200);
    assert.equal(await marca('Sin productos'), undefined);

    // Renombrar a un nombre que choca con productos iguales de otro fabricante no se hace.
    await alta({ tipo: 'calzado', marca: 'Choque', referencia: 'BT-1', talla: '25', color: 'Negro', modelo: 'BT-1' });
    const choque = await admin('PUT', `/api/stock/catalogo/marcas/${(await marca('Choque')).id}`, { nombre: 'Botitas Kids' });
    assert.equal(choque.status, 409);
  });

  test('el alta añade al catálogo los fabricantes nuevos y el tipo que les falte', async () => {
    await alta({ tipo: 'juguetes', marca: 'Juguetera', referencia: 'J-1' });
    assert.deepEqual((await marca('Juguetera')).ambitos, [{ tipo: 'juguetes', subtipo_id: null }]);
    await alta({ tipo: 'accesorios', marca: 'Juguetera', referencia: 'J-2', color: 'Rojo' });
    assert.deepEqual((await marca('Juguetera')).ambitos.map((a) => a.tipo).sort(), ['accesorios', 'juguetes']);
    // Uno de «todos los tipos» sigue igual.
    await admin('POST', '/api/stock/catalogo/marcas', { nombre: 'Universal' });
    await alta({ tipo: 'ropa', marca: 'Universal', referencia: 'U-1', talla: 'M', color: 'Azul' });
    assert.deepEqual((await marca('Universal')).ambitos, []);
  });

  test('sugerencias: lo que ya hay de ese fabricante, según lo elegido', async () => {
    await alta({ tipo: 'calzado', marca: 'Sugiere', modelo: 'Bota', referencia: 'S-1', talla: '28', color: 'Marino' });
    await alta({ tipo: 'calzado', marca: 'Sugiere', modelo: 'Bota', referencia: 'S-1', talla: '27', color: 'Rojo' });
    await alta({ tipo: 'calzado', marca: 'Sugiere', modelo: 'Sandalia', referencia: 'S-2', talla: '30', color: 'Blanco' });
    const todo = (await admin('GET', '/api/stock/sugerencias?marca=sugiere&tipo=calzado')).data;
    assert.deepEqual(todo.modelos, ['Bota', 'Sandalia']);
    assert.deepEqual(todo.referencias, ['S-1', 'S-2']);
    assert.deepEqual(todo.tallas, ['27', '28', '30'], 'ordenadas como tallas');
    const bota = (await admin('GET', '/api/stock/sugerencias?marca=Sugiere&tipo=calzado&modelo=bota')).data;
    assert.deepEqual(bota.referencias, ['S-1']);
    assert.deepEqual(bota.colores, ['Marino', 'Rojo']);
    assert.deepEqual((await admin('GET', '/api/stock/sugerencias?marca=Sugiere&tipo=ropa')).data.modelos, []);
    assert.deepEqual((await admin('GET', '/api/stock/sugerencias')).data.modelos, []);
    const marcas = (await empleado('GET', '/api/stock/marcas')).data;
    assert.ok(marcas.some((m) => m.nombre === 'Sugiere'));
  });

  test('solo administración cambia el catálogo; queda en el log', async () => {
    assert.equal((await empleado('GET', '/api/stock/catalogo')).status, 200);
    assert.equal((await empleado('POST', '/api/stock/catalogo/marcas', { nombre: 'X' })).status, 403);
    assert.equal((await empleado('POST', '/api/stock/catalogo/tipos', { nombre: 'X', tallas: ['unica'] })).status, 403);
    assert.equal((await empleado('DELETE', '/api/stock/catalogo/subtipos/1')).status, 403);
    assert.equal((await ctx.client()('GET', '/api/stock/catalogo')).status, 401);
    assert.equal((await admin('PUT', '/api/stock/catalogo/marcas/999999', { nombre: 'X' })).status, 404);
    assert.equal((await admin('DELETE', '/api/stock/catalogo/tipos/no-existe')).status, 404);
    const log = (await admin('GET', '/api/admin/log?area=stock')).data;
    const filas = log.rows ?? log.entries ?? log;
    const textos = JSON.stringify(filas);
    assert.match(textos, /Catálogo · fabricante Botitas Kids/);
    assert.match(textos, /Productos renombrados/);
    assert.match(textos, /Catálogo · tipo Bolsos/);
  });
});
