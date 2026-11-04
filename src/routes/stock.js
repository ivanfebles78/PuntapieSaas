import express, { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { extraer } from '../proveedores/analisis.js';
import { leerArchivo, obtenerDocumento, withTransaction } from '../proveedores/repo.js';
import { auditFrom } from '../services/audit.js';
import { formatEuros } from '../services/money.js';
import { todayInShop } from '../services/vacation-balance.js';
import { confirmarAlta, etiquetaSku, resumenAlta, revisarAlta, revisionPublica } from '../stock/alta.js';
import { leerExcelAlta, plantillaAlta } from '../stock/alta-excel.js';
import { generarEtiquetasPdf } from '../stock/pdf/etiquetas.js';
import {
  actualizarArticulo,
  etiquetasPara,
  listarEntradas,
  listarInventario,
  listarSubtipos,
  obtenerEntrada,
  documentoConProductos,
  recibirEntrada,
  registrarEntrada,
  resolverFalta,
  resumenInventario,
} from '../stock/repo.js';
import { resolverProductos } from '../correo/repo.js';
import { catalogoTipos, proponerTipos } from '../stock/propuesta.js';
import { TIPOS } from '../stock/tipos.js';

// Stock: inventario, recepción de mercancía y etiquetas con código de barras.

const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
const JSON_ALTA = express.json({ limit: '2mb' });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const entradaLabel = (e) => `${e.documento.tipo === 'pedido' ? 'Pedido' : 'Factura'} ${e.documento.numero} · ${e.documento.proveedor.nombre}`;
const skuLabel = (a) => `${a.marca} ${a.referencia} ${a.color} T.${a.talla}`;

function readId(value, label = 'Ese documento') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

export function stockRouter({ pool, config, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const canWrite = requireRole('admin', 'empleado');

  router.get('/inventario', handle(async (req, res) => {
    const { q, tipo, estado } = req.query;
    const [articulos, resumen] = await Promise.all([listarInventario(pool, { q, tipo, estado }), resumenInventario(pool)]);
    res.json({ ok: true, data: { articulos, resumen } });
  }));

  // Tipos de producto (con las tallas que admite cada uno) y sus subtipos.
  router.get('/tipos', handle(async (_req, res) => {
    res.json({ ok: true, data: await catalogoTipos(pool) });
  }));

  router.put('/articulos/:id', canWrite, handle(async (req, res) => {
    const { before, after } = await actualizarArticulo(pool, readId(req.params.id, 'Ese artículo'), req.body ?? {});
    const subtipos = new Map((await listarSubtipos(pool)).map((s) => [s.id, s.nombre]));
    const plain = (v) => v || null;
    const show = {
      modelo: plain, color: plain, detalle: plain, codigo_fabricante: plain,
      tipo: (v) => TIPOS[v]?.nombre ?? v,
      subtipo_id: (v) => (v == null ? null : subtipos.get(v) ?? String(v)),
      pvp_cent: (v) => (v == null ? null : formatEuros(v)),
    };
    const changes = [['modelo', 'Modelo'], ['color', 'Color'], ['tipo', 'Tipo'], ['subtipo_id', 'Subtipo'], ['detalle', 'Detalle'],
      ['codigo_fabricante', 'Código de fábrica'], ['pvp_cent', 'PVP']]
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

  // Documentos ya guardados sin productos: se vuelven a leer de su PDF…
  router.get('/entradas/:docId/leer', canWrite, handle(async (req, res) => {
    const doc = await obtenerDocumento(pool, readId(req.params.docId));
    if (!doc.archivo) throw new HttpError(409, 'Este documento no tiene PDF del que leer los productos.', 'NO_PDF');
    const { data } = await leerArchivo(pool, doc.archivo);
    const { extraido } = await extraer(data, config?.proveedores);
    const ya = await pool.query('SELECT 1 FROM inventory_incoming WHERE doc_id = $1 LIMIT 1', [doc.id]);
    if (ya.rowCount) throw new HttpError(409, 'Este documento ya tiene sus productos dados de alta en Stock.', 'LINES_EXIST');
    const productosEnPedido = await documentoConProductos(pool, { tipo: doc.tipo, proveedorId: doc.proveedor_id, numero: doc.numero, pedidos: doc.pedidos, excluir: doc.id });
    const lineas = await proponerTipos(pool, extraido.lineas, { marca: doc.proveedor.nombre, parser: extraido.parser });
    res.json({ ok: true, data: { lineas, parser: extraido.parser, tipo: doc.tipo, avisos: extraido.avisos, productos_en_pedido: productosEnPedido, tipos: await catalogoTipos(pool) } });
  }));

  // …y se dan de alta como pendientes de recibir.
  router.post('/entradas/:docId', canWrite, handle(async (req, res) => {
    const docId = readId(req.params.docId);
    const { lineas, marca } = req.body ?? {};
    if (!Array.isArray(lineas) || !lineas.length) throw new HttpError(400, 'No hay productos que dar de alta.', 'NO_LINES');
    const r = await withTransaction(pool, async (client) => {
      const doc = await obtenerDocumento(client, docId);
      const entrada = await registrarEntrada(client, doc, lineas, marca ?? doc.proveedor.nombre);
      // Una factura llegada por correo con los productos por repartir queda resuelta.
      if (entrada.lineas) await resolverProductos(client, docId);
      return entrada;
    });
    if (r.omitido) throw new HttpError(409, `Los productos ya están dados de alta con ${r.omitido.tipo === 'factura' ? 'la factura' : 'el pedido'} ${r.omitido.numero}.`, 'LINES_IN_LINKED_DOC');
    const entrada = await obtenerEntrada(pool, docId);
    await audit(req, { area: 'stock', action: 'crear', target: entradaLabel(entrada), changes: [{ field: 'Mercancía pendiente de recibir', from: null, to: `${r.unidades} uds. en ${r.lineas} líneas` }] });
    res.status(201).json({ ok: true, data: entrada });
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

  /* ----- Alta de productos sin pedido: uno a uno o desde un Excel ----- */

  router.get('/alta/plantilla.xlsx', handle(async (_req, res) => {
    const subtipos = (await pool.query('SELECT type, name FROM product_subtypes ORDER BY type, name')).rows;
    res.setHeader('Content-Type', XLSX);
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-inventario.xlsx"');
    res.send(await plantillaAlta(subtipos));
  }));

  // Sube el Excel: devuelve las filas leídas (para confirmarlas después) y qué pasará con cada una.
  router.post('/alta/excel', canWrite, express.raw({ type: () => true, limit: MAX_EXCEL_BYTES }), handle(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Elige un archivo Excel.', 'NO_FILE');
    const filas = await leerExcelAlta(req.body);
    res.json({ ok: true, data: { filas, revision: revisionPublica(await revisarAlta(pool, filas)) } });
  }));

  router.post('/alta/revisar', canWrite, JSON_ALTA, handle(async (req, res) => {
    res.json({ ok: true, data: revisionPublica(await revisarAlta(pool, req.body?.filas)) });
  }));

  router.post('/alta/confirmar', canWrite, JSON_ALTA, handle(async (req, res) => {
    const hechos = await confirmarAlta(pool, req.body?.filas, req.body?.decisiones ?? {});
    const resumen = resumenAlta(hechos);
    const porExcel = req.body?.origen === 'excel';
    const unico = hechos.length === 1 ? hechos[0] : null;
    await audit(req, unico && !porExcel
      ? {
        area: 'stock', action: unico.accion === 'nuevo' ? 'crear' : 'editar', target: etiquetaSku(unico.articulo),
        changes: [{ field: 'Stock', from: unico.accion === 'nuevo' ? null : String(unico.antes), to: String(unico.articulo.stock) },
          ...(unico.accion === 'actualizar' ? [{ field: 'Datos', from: null, to: 'Actualizados con los del alta' }] : [])],
      }
      : {
        area: 'stock', action: 'importar', target: porExcel ? 'Inventario desde Excel' : 'Alta de inventario',
        changes: [
          { field: 'Productos nuevos', from: null, to: String(resumen.nuevos) },
          { field: 'Productos con unidades sumadas', from: null, to: String(resumen.sumados) },
          { field: 'Datos actualizados', from: null, to: String(resumen.actualizados) },
          { field: 'Unidades', from: null, to: String(resumen.unidades) },
        ],
      });
    const articulos = hechos.filter((x) => x.accion !== 'omitir').map((x) => ({
      id: x.articulo.id, codigo: x.articulo.barcode, descripcion: etiquetaSku(x.articulo), accion: x.accion, unidades: x.unidades, stock: x.articulo.stock,
    }));
    res.status(201).json({ ok: true, data: { resumen, articulos } });
  }));

  // Etiquetas de varios artículos a la vez: { articulos: [{ id, copias }] }.
  router.post('/alta/etiquetas.pdf', JSON_ALTA, handle(async (req, res) => {
    const etiquetas = await etiquetasPara(pool, { lista: req.body?.articulos });
    if (!etiquetas.length) throw new HttpError(404, 'No hay etiquetas que imprimir.', 'NO_LABELS');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="etiquetas-${todayInShop()}.pdf"`);
    res.send(generarEtiquetasPdf(etiquetas));
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
  router.use((error, _req, res, next) => (error.type === 'entity.too.large'
    ? res.status(413).json({ ok: false, error: 'Es demasiado grande para enviarlo de una vez (el Excel, como mucho 5 MB): divídelo en varios.', code: 'FILE_TOO_LARGE' })
    : next(error)));
  return router;
}
