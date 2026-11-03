import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { auditFrom } from '../services/audit.js';
import { formatEuros } from '../services/money.js';
import { authenticate } from '../services/users.js';
import { comprobarAprobacion, crearSolicitud, decidir, estadoSolicitud, marcarAvisada, solicitudPorToken } from '../tpv/aprobaciones.js';
import { buscarArticulos, obtenerTicket, prepararVenta, registrarVenta } from '../tpv/repo.js';
import { enlaceManual, enviarAviso, whatsappAutomatico } from '../tpv/whatsapp.js';

// TPV › Venta: buscar artículos, cobrar (con varios métodos), descuentos de
// más del 15 % con aprobación de un Administrador y tickets.

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const INTENTOS_VENTANA_MS = 15 * 60 * 1000;

function readId(value, label = 'Ese ticket') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

export function tpvRouter({ pool, config, log = console, enviar = fetch }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const vende = requireRole('admin', 'empleado');
  const soloAdmin = requireRole('admin');
  // Usuario y contraseña del Administrador en la caja: pocos intentos.
  const limitePresencial = rateLimit({
    windowMs: INTENTOS_VENTANA_MS, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: 'Demasiados intentos. Espera unos minutos.' },
  });

  router.get('/buscar', vende, handle(async (req, res) => {
    res.json({ ok: true, data: await buscarArticulos(pool, req.query.q) });
  }));

  // Cálculo con los precios del stock (la pantalla lo usa para mostrar totales y la regla del 15 %).
  router.post('/calcular', vende, handle(async (req, res) => {
    res.json({ ok: true, data: await prepararVenta(pool, req.body) });
  }));

  router.post('/ventas', vende, handle(async (req, res) => {
    const calculo = await prepararVenta(pool, req.body);
    const vendedor = req.user;
    let aprobacionId = null;
    if (calculo.requiere_aprobacion && vendedor.role !== 'admin') {
      aprobacionId = await comprobarAprobacion(pool, req.body.aprobacion_id, { calculo, vendedor });
    }
    const r = await registrarVenta(pool, { venta: req.body, calculo, vendedor, aprobacionId });
    if (calculo.descuento_cent > 0 && calculo.requiere_aprobacion) {
      await audit(req, {
        area: 'ventas', action: 'crear', target: `Ticket ${r.numero}`,
        changes: [{ field: 'Descuento', from: formatEuros(calculo.subtotal_cent), to: `${formatEuros(calculo.total_cent)} (−${calculo.pct_descuento} %)` }],
      });
    }
    res.status(201).json({ ok: true, data: { ...(await obtenerTicket(pool, r.id, config.tienda)), sin_stock: r.sin_stock } });
  }));

  router.get('/tickets/:id', handle(async (req, res) => {
    res.json({ ok: true, data: await obtenerTicket(pool, readId(req.params.id), config.tienda) });
  }));

  /* ---------- Descuentos de más del 15 % ---------- */

  // En persona: el Administrador escribe su usuario y contraseña en la caja.
  router.post('/aprobaciones/presencial', vende, limitePresencial, handle(async (req, res) => {
    const { usuario, contrasena, venta } = req.body ?? {};
    const admin = await authenticate(pool, String(usuario ?? ''), String(contrasena ?? ''));
    if (!admin || admin.role !== 'admin') throw new HttpError(403, 'Usuario o contraseña incorrectos, o no es un Administrador.', 'NOT_ADMIN');
    const calculo = await prepararVenta(pool, venta);
    const s = await crearSolicitud(pool, { calculo, solicitante: req.user, canal: 'presencial', estado: 'aprobado', decididoPor: admin.id });
    await audit(req, {
      area: 'ventas', action: 'editar', target: `Descuento del ${calculo.pct_descuento} %`,
      changes: [{ field: 'Aprobado en la caja por', from: null, to: admin.name }],
    });
    res.status(201).json({ ok: true, data: await estadoSolicitud(pool, s.id, req.user) });
  }));

  // A distancia: se avisa por WhatsApp con un enlace para aprobar o rechazar.
  router.post('/aprobaciones', vende, handle(async (req, res) => {
    const calculo = await prepararVenta(pool, req.body?.venta);
    if (!calculo.requiere_aprobacion) throw new HttpError(400, 'Este descuento no necesita aprobación.', 'NO_APPROVAL_NEEDED');
    const s = await crearSolicitud(pool, { calculo, solicitante: req.user, canal: 'whatsapp' });
    const datos = {
      quien: req.user.name, pct: calculo.pct_descuento, total: calculo.total_cent,
      enlace: `${config.appUrl}/app/ventas/tpv?aprobar=${encodeURIComponent(s.token)}`,
    };
    const auto = whatsappAutomatico(config.whatsapp);
    const enviados = auto ? await enviarAviso(config.whatsapp, datos, { enviar, log }) : 0;
    await marcarAvisada(pool, s.id, enviados ? `whatsapp:${enviados}` : 'manual');
    res.status(201).json({
      ok: true,
      data: { ...(await estadoSolicitud(pool, s.id, req.user)), enviado: enviados > 0, enlace_whatsapp: enviados ? null : enlaceManual(config.whatsapp, datos) },
    });
  }));

  router.get('/aprobaciones/:id', vende, handle(async (req, res) => {
    res.json({ ok: true, data: await estadoSolicitud(pool, readId(req.params.id, 'Esa solicitud'), req.user) });
  }));

  router.get('/aprobar/:token', soloAdmin, handle(async (req, res) => {
    res.json({ ok: true, data: await solicitudPorToken(pool, req.params.token) });
  }));

  router.post('/aprobar/:token', soloAdmin, handle(async (req, res) => {
    const aprobar = req.body?.decision === 'aprobar';
    const s = await decidir(pool, req.params.token, { aprobar, admin: req.user });
    await audit(req, {
      area: 'ventas', action: 'editar', target: `Descuento del ${s.pct} % pedido por ${s.solicitante}`,
      changes: [{ field: 'Decisión', from: 'Pendiente', to: aprobar ? 'Aprobado' : 'Rechazado' }],
    });
    res.json({ ok: true, data: s });
  }));

  router.use(httpErrorHandler);
  return router;
}
