import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { auditFrom } from '../services/audit.js';
import {
  caducarReservas, cancelarReserva, crearReserva, ESTADOS_RESERVA, listarReservas, obtenerReserva, prorrogarReserva,
} from '../tpv/reservas.js';

// Reservas del TPV (apartados sin pagar). Las crean, anulan y venden quienes
// venden; las prorroga un Administrador; el Asesor solo las ve. La venta de una
// reserva se cobra en la venta normal del TPV (POST /api/tpv/ventas con `reserva_id`).

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, 'Esa reserva no existe.', 'NOT_FOUND');
  return id;
}

const fecha = (iso) => iso.split('-').reverse().join('/');
const productos = (r) => r.lineas.map((l) => `${l.cantidad} × ${l.descripcion}${l.talla && l.talla !== 'Única' ? ` T. ${l.talla}` : ''}`).join(', ');

export function reservasRouter({ pool, config, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const vende = requireRole('admin', 'empleado');
  const soloAdmin = requireRole('admin');
  const diasMax = config.tpv.reservaDias;

  router.get('/', handle(async (req, res) => {
    await caducarReservas(pool);
    res.json({ ok: true, data: { ...(await listarReservas(pool, { estado: String(req.query.estado ?? 'activas') })), dias_max: diasMax } });
  }));

  router.get('/:id', handle(async (req, res) => {
    res.json({ ok: true, data: await obtenerReserva(pool, readId(req.params.id)) });
  }));

  router.post('/', vende, handle(async (req, res) => {
    const id = await crearReserva(pool, { datos: req.body, usuario: req.user, diasMax });
    const r = await obtenerReserva(pool, id);
    await audit(req, {
      area: 'reservas', action: 'crear', target: `Reserva ${id}`,
      changes: [{ field: 'Productos', from: null, to: productos(r) }, { field: 'Hasta', from: null, to: fecha(r.hasta) }],
    });
    res.status(201).json({ ok: true, data: r });
  }));

  router.post('/:id/anular', vende, handle(async (req, res) => {
    const id = readId(req.params.id);
    await cancelarReserva(pool, id, { motivo: req.body?.motivo, usuario: req.user });
    const r = await obtenerReserva(pool, id);
    // El motivo es texto libre (puede llevar datos del cliente): no va al log, que no se borra.
    await audit(req, {
      area: 'reservas', action: 'editar', target: `Reserva ${id}`,
      changes: [{ field: 'Estado', from: ESTADOS_RESERVA.activa, to: ESTADOS_RESERVA.cancelada }],
    });
    res.json({ ok: true, data: r });
  }));

  router.post('/:id/prorrogar', soloAdmin, handle(async (req, res) => {
    const id = readId(req.params.id);
    const antes = await obtenerReserva(pool, id);
    const p = await prorrogarReserva(pool, id, { dias: req.body?.dias, usuario: req.user, diasMax });
    const r = await obtenerReserva(pool, id);
    await audit(req, {
      area: 'reservas', action: 'editar', target: `Reserva ${id}`,
      changes: [
        ...(p.reactivada ? [{ field: 'Estado', from: ESTADOS_RESERVA.caducada, to: ESTADOS_RESERVA.activa }] : []),
        { field: 'Hasta', from: fecha(antes.hasta), to: fecha(r.hasta) },
      ],
    });
    res.json({ ok: true, data: r });
  }));

  router.use(httpErrorHandler);
  return router;
}
