import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { auditFrom } from '../services/audit.js';
import { formatEuros } from '../services/money.js';
import { todayInShop } from '../services/vacation-balance.js';
import { generarEtiquetasPdf } from '../stock/pdf/etiquetas.js';
import {
  actualizarArticulo,
  etiquetasPara,
  listarEntradas,
  listarInventario,
  obtenerEntrada,
  recibirEntrada,
  resolverFalta,
  resumenInventario,
} from '../stock/repo.js';

// Stock: inventario, recepción de mercancía y etiquetas con código de barras.

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const entradaLabel = (e) => `${e.documento.tipo === 'pedido' ? 'Pedido' : 'Factura'} ${e.documento.numero} · ${e.documento.proveedor.nombre}`;
const skuLabel = (a) => `${a.marca} ${a.referencia} ${a.color} T.${a.talla}`;

function readId(value, label = 'Ese documento') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

export function stockRouter({ pool, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const canWrite = requireRole('admin', 'empleado');

  router.get('/inventario', handle(async (req, res) => {
    const { q, estado } = req.query;
    const [articulos, resumen] = await Promise.all([listarInventario(pool, { q, estado }), resumenInventario(pool)]);
    res.json({ ok: true, data: { articulos, resumen } });
  }));

  router.put('/articulos/:id', canWrite, handle(async (req, res) => {
    const { before, after } = await actualizarArticulo(pool, readId(req.params.id, 'Ese artículo'), req.body ?? {});
    const show = { modelo: (v) => v, color: (v) => v, pvp_cent: (v) => (v == null ? null : formatEuros(v)) };
    const changes = [['modelo', 'Modelo'], ['color', 'Color'], ['pvp_cent', 'PVP']]
      .filter(([k]) => before[k] !== after[k])
      .map(([k, field]) => ({ field, from: show[k](before[k]), to: show[k](after[k]) }));
    if (changes.length) await audit(req, { area: 'stock', action: 'editar', target: skuLabel(after), changes });
    res.json({ ok: true, data: after });
  }));

  router.get('/entradas', handle(async (req, res) => {
    res.json({ ok: true, data: await listarEntradas(pool, { estado: req.query.estado }) });
  }));

  router.get('/entradas/:docId', handle(async (req, res) => {
    res.json({ ok: true, data: await obtenerEntrada(pool, readId(req.params.docId)) });
  }));

  // Recepción: todo lo pendiente llega salvo lo marcado en `faltan`.
  router.post('/entradas/:docId/recibir', canWrite, handle(async (req, res) => {
    const docId = readId(req.params.docId);
    const r = await recibirEntrada(pool, docId, req.body?.faltan ?? {}, req.user.id);
    await audit(req, {
      area: 'stock',
      action: 'recibir',
      target: entradaLabel(r.entrada),
      changes: [
        { field: 'Unidades recibidas', from: null, to: String(r.recibidas) },
        ...(r.faltan ? [{ field: 'Unidades que faltan', from: null, to: String(r.faltan) }] : []),
      ],
    });
    res.json({ ok: true, data: r });
  }));

  router.post('/lineas/:id/:accion', canWrite, handle(async (req, res) => {
    const r = await resolverFalta(pool, readId(req.params.id, 'Esa línea'), req.params.accion, req.user.id);
    await audit(req, {
      area: 'stock',
      action: req.params.accion === 'llegado' ? 'recibir' : 'anular',
      target: entradaLabel(r.entrada),
      changes: [{ field: req.params.accion === 'llegado' ? 'Falta recibida' : 'Falta anulada', from: null, to: String(r.unidades) }],
    });
    res.json({ ok: true, data: r.entrada });
  }));

  // ?doc=ID[&lineas=1,2] o ?articulo=ID&copias=N. ?ver=1 lo abre en el navegador.
  router.get('/etiquetas.pdf', handle(async (req, res) => {
    const { doc, lineas, articulo, copias } = req.query;
    const etiquetas = await etiquetasPara(pool, {
      docId: doc ? Number(doc) : null,
      lineas: lineas ? String(lineas).split(',') : null,
      articulo: articulo ? Number(articulo) : null,
      copias: copias ?? 1,
    });
    if (!etiquetas.length) throw new HttpError(404, 'No hay etiquetas que imprimir.', 'NO_LABELS');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.ver === '1' ? 'inline' : 'attachment'}; filename="etiquetas-${todayInShop()}.pdf"`);
    res.send(generarEtiquetasPdf(etiquetas));
  }));

  router.use(httpErrorHandler);
  return router;
}
