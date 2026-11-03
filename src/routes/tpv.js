import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { auditFrom } from '../services/audit.js';
import { formatEuros } from '../services/money.js';
import { authenticate } from '../services/users.js';
import {
  comprobarAprobacion, comprobarAprobacionCambio, crearSolicitud, decidir, estadoSolicitud, marcarAvisada, solicitudPorToken,
} from '../tpv/aprobaciones.js';
import { calcularCambio, registrarCambio, valorarDevueltos, ventasDeArticulo } from '../tpv/cambios.js';
import { leerCodigoVale, obtenerVale } from '../tpv/vales.js';
import {
  abrirCaja, cajaDiariaHoy, cerrarCaja, DENOMINACIONES, leerRecuento, movimiento, resumenSesion, sesionAbierta, ultimoCierre,
} from '../tpv/caja.js';
import { buscarArticulos, obtenerTicket, prepararVenta, registrarVenta, resumenHoy } from '../tpv/repo.js';
import { enlaceManual, enviarAviso, textoSolicitud, whatsappAutomatico } from '../tpv/whatsapp.js';

// TPV: venta (buscar, cobrar con varios métodos, tickets), caja (apertura,
// entradas y salidas de dinero, arqueo y cierre) y aprobaciones de un
// Administrador (descuentos de más del 15 % y cierres que no cuadran).

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const INTENTOS_VENTANA_MS = 15 * 60 * 1000;
const VALES_FALLOS_MAX = 20;

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

  // Buscar vales por su código: pocos fallos seguidos (nadie adivina códigos a base de probar).
  const limiteVales = rateLimit({
    windowMs: INTENTOS_VENTANA_MS, limit: VALES_FALLOS_MAX, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: (req) => req.path.startsWith('/buscar') && !leerCodigoVale(req.query.q),
    message: { ok: false, error: 'Demasiados códigos de vale que no existen. Espera unos minutos.', code: 'TOO_MANY_VOUCHER_LOOKUPS' },
  });

  /** Usuario y contraseña de un Administrador escritos en la caja. */
  async function adminPresente(body) {
    const admin = await authenticate(pool, String(body?.usuario ?? ''), String(body?.contrasena ?? ''));
    if (!admin || admin.role !== 'admin') throw new HttpError(403, 'Usuario o contraseña incorrectos, o no es un Administrador.', 'NOT_ADMIN');
    return admin;
  }

  /** Avisa por WhatsApp (solo o con el mensaje escrito) y responde con el estado de la solicitud. */
  async function avisar(req, res, s, datos) {
    const enlace = `${config.appUrl}/app/ventas/tpv?aprobar=${encodeURIComponent(s.token)}`;
    const aviso = { texto: textoSolicitud({ quien: req.user.name, ...datos }), enlace };
    const enviados = whatsappAutomatico(config.whatsapp) ? await enviarAviso(config.whatsapp, aviso, { enviar, log }) : 0;
    await marcarAvisada(pool, s.id, enviados ? `whatsapp:${enviados}` : 'manual');
    res.status(201).json({
      ok: true,
      data: { ...(await estadoSolicitud(pool, s.id, req.user)), enviado: enviados > 0, enlace_whatsapp: enviados ? null : enlaceManual(config.whatsapp, aviso) },
    });
  }

  /* ---------- Venta ---------- */

  // Lo escaneado puede ser un artículo o el QR de un vale (entonces se enseña el vale).
  router.get('/buscar', vende, limiteVales, handle(async (req, res) => {
    if (leerCodigoVale(req.query.q)) return void res.json({ ok: true, data: { exacto: null, modelos: [], vale: await obtenerVale(pool, req.query.q) } });
    return void res.json({ ok: true, data: await buscarArticulos(pool, req.query.q) });
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

  // Lo vendido hoy en el TPV y el estado de la caja (para la pantalla de inicio).
  router.get('/hoy', handle(async (_req, res) => {
    const s = await sesionAbierta(pool);
    res.json({ ok: true, data: { ...(await resumenHoy(pool)), caja: s ? { abierta: true, desde: s.opened_at } : { abierta: false } } });
  }));

  /* ---------- Descuentos de más del 15 % ---------- */

  // En persona: el Administrador escribe su usuario y contraseña en la caja.
  router.post('/aprobaciones/presencial', vende, limitePresencial, handle(async (req, res) => {
    const admin = await adminPresente(req.body);
    const calculo = await prepararVenta(pool, req.body.venta);
    const s = await crearSolicitud(pool, { calculo, solicitante: req.user, canal: 'presencial', estado: 'aprobado', decididoPor: admin.id });
    await audit(req, { area: 'ventas', action: 'editar', target: `Descuento del ${calculo.pct_descuento} %`, changes: [{ field: 'Aprobado en la caja por', from: null, to: admin.name }] });
    res.status(201).json({ ok: true, data: await estadoSolicitud(pool, s.id, req.user) });
  }));

  // A distancia: se avisa por WhatsApp con un enlace para aprobar o rechazar.
  router.post('/aprobaciones', vende, handle(async (req, res) => {
    const calculo = await prepararVenta(pool, req.body?.venta);
    if (!calculo.requiere_aprobacion) throw new HttpError(400, 'Este descuento no necesita aprobación.', 'NO_APPROVAL_NEEDED');
    const s = await crearSolicitud(pool, { calculo, solicitante: req.user, canal: 'whatsapp' });
    await avisar(req, res, s, { tipo: 'descuento', pct: calculo.pct_descuento, total: calculo.total_cent });
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
    const que = { cierre: `Cierre de caja con descuadre pedido por ${s.solicitante}`, cambio: `Cambio por ${formatEuros(s.total_cent)} pedido por ${s.solicitante}` }[s.tipo] ?? `Descuento del ${s.pct} % pedido por ${s.solicitante}`;
    await audit(req, { area: 'ventas', action: 'editar', target: que, changes: [{ field: 'Decisión', from: 'Pendiente', to: aprobar ? 'Aprobado' : 'Rechazado' }] });
    res.json({ ok: true, data: s });
  }));

  /* ---------- Cambios y vales ---------- */

  // Producto que se devuelve: sus ventas en el TPV (para elegir de cuál sale) o, si no se encuentra exacto, los modelos.
  router.get('/cambios/articulo', vende, handle(async (req, res) => {
    const r = await buscarArticulos(pool, req.query.q);
    if (!r.exacto) return void res.json({ ok: true, data: { articulo: null, modelos: r.modelos } });
    return void res.json({ ok: true, data: { articulo: r.exacto, ventas: await ventasDeArticulo(pool, r.exacto.id) } });
  }));

  router.get('/cambios/ventas/:articuloId', vende, handle(async (req, res) => {
    res.json({ ok: true, data: await ventasDeArticulo(pool, readId(req.params.articuloId, 'Ese artículo')) });
  }));

  router.post('/cambios/calcular', vende, handle(async (req, res) => {
    res.json({ ok: true, data: await calcularCambio(pool, req.body) });
  }));

  router.post('/cambios', vende, handle(async (req, res) => {
    const vendedor = req.user;
    const r = await registrarCambio(pool, {
      cambio: req.body,
      vendedor,
      valeMeses: config.tpv.valeMeses,
      comprobarAprobacion: (client, credito) => comprobarAprobacionCambio(client, req.body?.aprobacion_id, { credito, vendedor }),
    });
    await audit(req, {
      area: 'ventas', action: 'crear', target: `Devolución ${r.rectificativa.numero}${r.venta ? ` y venta ${r.venta.numero}` : ''}`,
      changes: [
        { field: 'Devuelto', from: null, to: formatEuros(r.credito) },
        ...(r.vale ? [{ field: 'Vale emitido', from: null, to: r.vale.codigo }] : []),
        ...(r.motivos.length ? [{ field: 'Con aprobación', from: null, to: r.motivos.join(', ') }] : []),
      ],
    });
    const rectificativa = await obtenerTicket(pool, r.rectificativa.id, config.tienda);
    const venta = r.venta ? await obtenerTicket(pool, r.venta.id, config.tienda) : null;
    const vale = r.vale ? await obtenerVale(pool, r.vale.codigo, { conQr: true }) : null;
    res.status(201).json({ ok: true, data: { rectificativa, venta, vale, tienda: config.tienda, sin_stock: r.sin_stock } });
  }));

  router.post('/cambios/aprobaciones/presencial', vende, limitePresencial, handle(async (req, res) => {
    const admin = await adminPresente(req.body);
    const dev = await valorarDevueltos(pool, req.body?.devueltos);
    if (!dev.requiere_aprobacion) throw new HttpError(400, 'Este cambio no necesita aprobación.', 'NO_APPROVAL_NEEDED');
    const s = await crearSolicitud(pool, { cambio: dev, solicitante: req.user, canal: 'presencial', estado: 'aprobado', decididoPor: admin.id });
    await audit(req, { area: 'ventas', action: 'editar', target: `Cambio por ${formatEuros(dev.credito)} (${dev.motivos.join(', ')})`, changes: [{ field: 'Aprobado en la caja por', from: null, to: admin.name }] });
    res.status(201).json({ ok: true, data: await estadoSolicitud(pool, s.id, req.user) });
  }));

  router.post('/cambios/aprobaciones', vende, handle(async (req, res) => {
    const dev = await valorarDevueltos(pool, req.body?.devueltos);
    if (!dev.requiere_aprobacion) throw new HttpError(400, 'Este cambio no necesita aprobación.', 'NO_APPROVAL_NEEDED');
    const s = await crearSolicitud(pool, { cambio: dev, solicitante: req.user, canal: 'whatsapp' });
    await avisar(req, res, s, { tipo: 'cambio', total: dev.credito, motivos: dev.motivos });
  }));

  // Un vale (al escanear su QR): importe, saldo, caducidad y usos; con el QR para reimprimirlo.
  router.get('/vales/:codigo', limiteVales, handle(async (req, res) => {
    res.json({ ok: true, data: { ...(await obtenerVale(pool, req.params.codigo, { conQr: true })), tienda: config.tienda } });
  }));

  /* ---------- Caja: apertura, movimientos y cierre ---------- */

  router.get('/caja', handle(async (_req, res) => {
    const s = await sesionAbierta(pool);
    const ultimo = await ultimoCierre(pool);
    res.json({
      ok: true,
      data: {
        abierta: s ? await resumenSesion(pool, s.id) : null,
        denominaciones: DENOMINACIONES,
        recuento_sugerido: ultimo?.closing_counts ?? {},
        caja_diaria_hoy: await cajaDiariaHoy(pool),
      },
    });
  }));

  router.post('/caja/abrir', vende, handle(async (req, res) => {
    const id = await abrirCaja(pool, { recuento: req.body?.recuento, usuario: req.user });
    const r = await resumenSesion(pool, id);
    await audit(req, { area: 'ventas', action: 'crear', target: 'Apertura de caja', changes: [{ field: 'Dinero inicial', from: null, to: formatEuros(r.inicial_cent) }] });
    res.status(201).json({ ok: true, data: r });
  }));

  router.post('/caja/movimientos', vende, handle(async (req, res) => {
    const { tipo, importe_cent: importe, concepto } = req.body ?? {};
    await movimiento(pool, { tipo, importe, concepto, usuario: req.user });
    await audit(req, { area: 'ventas', action: 'crear', target: `${tipo === 'entrada' ? 'Entrada' : 'Salida'} de dinero de la caja`, changes: [{ field: String(concepto ?? ''), from: null, to: formatEuros(Number(importe)) }] });
    const s = await sesionAbierta(pool);
    res.status(201).json({ ok: true, data: await resumenSesion(pool, s.id) });
  }));

  /** El cierre que se quiere aprobar: lo esperado ahora y lo contado. */
  async function cierrePedido(recuento) {
    const s = await sesionAbierta(pool);
    if (!s) throw new HttpError(409, 'La caja ya está cerrada.', 'CASH_CLOSED');
    const r = await resumenSesion(pool, s.id);
    const { total } = leerRecuento(recuento);
    if (total === r.esperado_cent) throw new HttpError(400, 'La caja cuadra: no necesita aprobación.', 'NO_APPROVAL_NEEDED');
    return { sesionId: s.id, esperado: r.esperado_cent, contado: total };
  }

  router.post('/caja/aprobaciones/presencial', vende, limitePresencial, handle(async (req, res) => {
    const admin = await adminPresente(req.body);
    const cierre = await cierrePedido(req.body?.recuento);
    const s = await crearSolicitud(pool, { cierre, solicitante: req.user, canal: 'presencial', estado: 'aprobado', decididoPor: admin.id });
    await audit(req, { area: 'ventas', action: 'editar', target: 'Cierre de caja con descuadre', changes: [{ field: 'Aprobado en la caja por', from: null, to: admin.name }] });
    res.status(201).json({ ok: true, data: await estadoSolicitud(pool, s.id, req.user) });
  }));

  router.post('/caja/aprobaciones', vende, handle(async (req, res) => {
    const cierre = await cierrePedido(req.body?.recuento);
    const s = await crearSolicitud(pool, { cierre, solicitante: req.user, canal: 'whatsapp' });
    await avisar(req, res, s, { tipo: 'cierre', esperado: cierre.esperado, contado: cierre.contado });
  }));

  router.post('/caja/cerrar', vende, handle(async (req, res) => {
    const r = await cerrarCaja(pool, { recuento: req.body?.recuento, usuario: req.user, aprobacionId: req.body?.aprobacion_id });
    const informe = await resumenSesion(pool, r.id);
    await audit(req, {
      area: 'ventas', action: 'editar', target: 'Cierre de caja',
      changes: [
        { field: 'Esperado', from: null, to: formatEuros(informe.esperado_cent) },
        { field: 'Contado', from: null, to: formatEuros(informe.contado_cent) },
        ...(r.diferencia ? [{ field: 'Descuadre', from: null, to: formatEuros(r.diferencia) }] : []),
      ],
    });
    res.json({ ok: true, data: { ...informe, tienda: config.tienda } });
  }));

  router.get('/caja/:id', handle(async (req, res) => {
    res.json({ ok: true, data: { ...(await resumenSesion(pool, readId(req.params.id, 'Esa caja'))), tienda: config.tienda } });
  }));

  router.use(httpErrorHandler);
  return router;
}
