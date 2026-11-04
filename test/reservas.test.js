import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { caducarReservas } from '../src/tpv/reservas.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_DATABASE_URL, startTestServer } from './helpers.js';

describe('TPV: reservas sin pagar', { skip: !TEST_DATABASE_URL && 'Falta TEST_DATABASE_URL' }, () => {
  let ctx;
  let admin;
  let elena;
  let asesor;
  const art = {};

  const fisico = async (a) => (await ctx.pool.query('SELECT stock FROM inventory_items WHERE id = $1', [a.id])).rows[0].stock;
  const enBusqueda = async (a) => (await elena('GET', `/api/tpv/buscar?q=${a.codigo}`)).data.exacto;
  const vender = (a, extra = {}) => elena('POST', '/api/tpv/ventas', {
    lineas: [{ articulo_id: a.id, cantidad: 1 }], pagos: [{ metodo: 'tarjeta', importe_cent: a.pvp_cent }], ...extra,
  });
  const reservar = (lineas, extra = {}) => elena('POST', '/api/reservas', { nombre: 'Zuleima', telefono: '600 111 222', lineas, ...extra });

  before(async () => {
    ctx = await startTestServer();
    admin = await ctx.loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    elena = await ctx.loginAs('epena', 'Test1234');
    await elena('POST', '/api/auth/change-password', { newPassword: 'Elena2026x', confirmPassword: 'Elena2026x' });
    const raquel = (await admin('GET', '/api/admin/users')).data.find((u) => u.username === 'rperez');
    await admin('PATCH', `/api/admin/users/${raquel.id}`, { role: 'asesor' });
    asesor = await ctx.loginAs('rperez', 'Test1234');
    await asesor('POST', '/api/auth/change-password', { newPassword: 'Asesor2026x', confirmPassword: 'Asesor2026x' });
    const ped = await admin('POST', '/api/proveedores/documentos', {
      tipo: 'pedido', proveedor: { nombre: 'Gioseppo' }, numero: 'P-RESERVA', total_cent: 100,
      lineas: [
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'R1', modelo: 'Rita', color: 'Azul', talla: 27, cantidad: 1, pvp_cent: 4500 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'S1', modelo: 'Sara', color: 'Rosa', talla: 30, cantidad: 2, pvp_cent: 5500 },
        { tipo: 'calzado', marca: 'Gioseppo', referencia: 'T1', modelo: 'Tea', color: 'Verde', talla: 25, cantidad: 3, pvp_cent: 3000 },
      ],
    });
    await admin('POST', `/api/stock/entradas/${ped.data.id}/recibir`, {});
    for (const a of (await admin('GET', '/api/stock/inventario')).data.articulos) art[a.referencia] = { ...a, pvp_cent: a.pvp_cent ?? { R1: 4500, S1: 5500, T1: 3000 }[a.referencia] };
    await elena('POST', '/api/tpv/caja/abrir', { recuento: { 2000: 5 } });
  });
  after(async () => {
    await ctx?.stop();
  });

  test('datos mínimos y validación: nombre obligatorio, teléfono opcional, como mucho 7 días', async () => {
    const lineas = [{ articulo_id: art.S1.id, cantidad: 1 }];
    assert.equal((await reservar(lineas, { nombre: ' ' })).status, 400);
    assert.match((await reservar(lineas, { telefono: '12' })).error, /teléfono/);
    assert.match((await reservar(lineas, { dias: 8 })).error, /como mucho 7 días/);
    assert.equal((await reservar([{ descripcion: 'libre', precio_cent: 100 }])).status, 400, 'solo productos del stock');
    assert.equal((await asesor('POST', '/api/reservas', { nombre: 'Zuleima', lineas })).status, 403, 'el Asesor solo las ve');
    const sinTel = await reservar(lineas, { telefono: '', dias: 2 });
    assert.equal(sinTel.status, 201);
    assert.equal(sinTel.data.telefono, null);
    assert.equal(sinTel.data.dias_restantes, 2);
    assert.equal((await elena('POST', `/api/reservas/${sinTel.data.id}/anular`, {})).status, 200);
  });

  test('apartar resta de lo disponible, no del stock físico; no se reserva lo que no queda libre', async () => {
    const r = await reservar([{ articulo_id: art.R1.id, cantidad: 1 }]);
    assert.equal(r.status, 201);
    assert.equal(r.data.estado, 'activa');
    assert.equal(r.data.dias_restantes, 7);
    assert.equal(r.data.telefono, '600111222');
    assert.equal(await fisico(art.R1), 1, 'sigue en la tienda');
    assert.equal((await enBusqueda(art.R1)).reservado, 1);
    const otra = await reservar([{ articulo_id: art.R1.id, cantidad: 1 }], { nombre: 'Luis' });
    assert.equal(otra.status, 409);
    assert.equal(otra.code, 'NOT_AVAILABLE');
    assert.equal((await asesor('GET', '/api/reservas')).status, 200);
    assert.deepEqual((await elena('GET', '/api/tpv/hoy')).data.reservas, { activas: 1, vencen_hoy: 0, vencen_manana: 0 });
  });

  test('dos cajeros sobre el último par: el reservado no se vende a otro; desde la reserva sí, y solo una vez', async () => {
    const r = (await elena('GET', '/api/reservas')).data.items.find((x) => x.lineas[0].articulo_id === art.R1.id);
    const otro = await vender(art.R1);
    assert.equal(otro.status, 409);
    assert.equal(otro.code, 'RESERVED');
    assert.match(otro.error, /reservado para Zuleima/);
    const [a, b] = await Promise.all([vender(art.R1, { reserva_id: r.id }), vender(art.R1, { reserva_id: r.id })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], 'la misma reserva no se cobra dos veces');
    const vendida = (await elena('GET', `/api/reservas/${r.id}`)).data;
    assert.equal(vendida.estado, 'vendida');
    assert.equal(vendida.ticket, (a.status === 201 ? a : b).data.numero);
    assert.equal(await fisico(art.R1), 0);
  });

  test('anular libera las unidades al momento', async () => {
    const r = await reservar([{ articulo_id: art.S1.id, cantidad: 2 }]);
    assert.equal(r.status, 201);
    assert.equal((await vender(art.S1)).status, 409);
    const anulada = await elena('POST', `/api/reservas/${r.data.id}/anular`, { motivo: 'Ya no lo quiere' });
    assert.equal(anulada.data.estado, 'cancelada');
    assert.equal((await elena('POST', `/api/reservas/${r.data.id}/anular`, {})).status, 409);
    assert.equal((await enBusqueda(art.S1)).reservado, 0);
  });

  test('al vencer se libera sola; la tarea la marca caducada (idempotente) y la prórroga es de un Administrador', async () => {
    const r = await reservar([{ articulo_id: art.S1.id, cantidad: 2 }]);
    assert.equal((await elena('POST', `/api/reservas/${r.data.id}/prorrogar`, { dias: 3 })).status, 403);
    assert.match((await admin('POST', `/api/reservas/${r.data.id}/prorrogar`, { dias: 3 })).error, /vencería antes/);
    await ctx.pool.query("UPDATE tpv_reservations SET expires_at = NOW() - interval '1 minute' WHERE id = $1", [r.data.id]);
    assert.equal((await enBusqueda(art.S1)).reservado, 0, 'vencida ya no aparta nada, aunque nadie la haya marcado');
    // Una prórroga cuando ya ha vencido vuelve a comprobar el stock: si se vendió una, ya no hay dos libres.
    assert.equal((await vender(art.S1)).status, 201);
    const tarde = await admin('POST', `/api/reservas/${r.data.id}/prorrogar`, { dias: 2 });
    assert.equal(tarde.status, 409);
    assert.equal(tarde.code, 'NOT_AVAILABLE');
    assert.deepEqual(await caducarReservas(ctx.pool), { caducadas: 1, borradas: 0 });
    assert.deepEqual(await caducarReservas(ctx.pool), { caducadas: 0, borradas: 0 });
    assert.equal((await elena('GET', `/api/reservas/${r.data.id}`)).data.estado, 'caducada');
    assert.ok((await elena('GET', '/api/reservas?estado=cerradas')).data.items.some((x) => x.id === r.data.id));

    const ok = await reservar([{ articulo_id: art.S1.id, cantidad: 1 }], { dias: 1 });
    const pr = await admin('POST', `/api/reservas/${ok.data.id}/prorrogar`, { dias: 5 });
    assert.equal(pr.status, 200);
    assert.deepEqual([pr.data.dias_restantes, pr.data.prorrogas], [5, 1]);
  });

  test('la venta de una reserva la lleva entera; un cambio no se lleva lo reservado; dos reservas a la vez; reactivar', async () => {
    const r = await reservar([{ articulo_id: art.T1.id, cantidad: 2 }]);
    assert.equal(r.status, 201);
    const media = await vender(art.T1, { reserva_id: r.data.id });
    assert.equal(media.status, 409, 'con una de las dos no se cierra la reserva');
    assert.equal(media.code, 'RESERVATION_MISMATCH');
    assert.equal((await vender(art.S1, { reserva_id: r.data.id })).code, 'RESERVATION_MISMATCH', 'ni con otro producto');
    assert.equal((await elena('GET', `/api/reservas/${r.data.id}`)).data.estado, 'activa');

    // Dos cajeros reservan a la vez la última unidad libre: solo una.
    const [a, b] = await Promise.all([reservar([{ articulo_id: art.T1.id, cantidad: 1 }], { nombre: 'Uno' }), reservar([{ articulo_id: art.T1.id, cantidad: 1 }], { nombre: 'Dos' })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);

    // Un cambio que se lleva lo reservado no deja nada a medias (ni rectificativa ni stock devuelto).
    const rectAntes = (await ctx.pool.query("SELECT count(*)::int AS n FROM tpv_tickets WHERE kind = 'rectificativa'")).rows[0].n;
    const hoy = new Date().toISOString().slice(0, 10);
    const cambio = await admin('POST', '/api/tpv/cambios', {
      devueltos: [{ articulo_id: art.R1.id, cantidad: 1, importe_cent: 4500, ticket_papel: '9', fecha_ticket: hoy }],
      nuevos: [{ articulo_id: art.T1.id, cantidad: 1 }],
    });
    assert.equal(cambio.status, 409);
    assert.equal(cambio.code, 'RESERVED');
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM tpv_tickets WHERE kind = 'rectificativa'")).rows[0].n, rectAntes);
    assert.equal(await fisico(art.R1), 0);

    assert.equal((await asesor('POST', `/api/reservas/${r.data.id}/anular`, {})).status, 403);
    assert.equal((await elena('GET', '/api/reservas?estado=constructor')).status, 400);

    // Caducada: un Administrador la reactiva si sigue libre, y se vende entera.
    await ctx.pool.query("UPDATE tpv_reservations SET expires_at = NOW() - interval '1 minute' WHERE id = $1", [r.data.id]);
    await caducarReservas(ctx.pool);
    assert.equal((await elena('POST', `/api/reservas/${r.data.id}/prorrogar`, { dias: 3 })).status, 403);
    const viva = await admin('POST', `/api/reservas/${r.data.id}/prorrogar`, { dias: 3 });
    assert.equal(viva.status, 200);
    assert.deepEqual([viva.data.estado, viva.data.dias_restantes], ['activa', 3]);
    const entera = await elena('POST', '/api/tpv/ventas', {
      lineas: [{ articulo_id: art.T1.id, cantidad: 2 }], pagos: [{ metodo: 'tarjeta', importe_cent: 6000 }], reserva_id: r.data.id,
    });
    assert.equal(entera.status, 201);
    assert.equal((await elena('GET', `/api/reservas/${r.data.id}`)).data.estado, 'vendida');
  });

  test('el contacto se borra 30 días después de cerrarla y el log no guarda el nombre del cliente', async () => {
    await ctx.pool.query("UPDATE tpv_reservations SET closed_at = NOW() - interval '31 days' WHERE status <> 'activa'");
    const { borradas } = await caducarReservas(ctx.pool);
    assert.ok(borradas >= 3);
    const viejas = (await ctx.pool.query("SELECT customer_name, phone, notes FROM tpv_reservations WHERE status <> 'activa'")).rows;
    assert.ok(viejas.every((v) => v.customer_name === 'Cliente' && v.phone === null && v.notes === ''));
    const log = (await admin('GET', '/api/admin/log?area=reservas')).data.items;
    assert.ok(log.length >= 5);
    assert.ok(!JSON.stringify(log).includes('600111222'), 'sin teléfonos en el log');
    assert.ok(!JSON.stringify(log).includes('Zuleima'), 'sin nombres de clientes en el log');
  });
});
