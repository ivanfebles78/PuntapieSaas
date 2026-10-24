import express, { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { sendStoredFile } from '../http-files.js';
import { analizarPdf, configPublica, consolidarArchivo, descartarTemporal, guardarSubida, limpiarTemporales } from '../proveedores/analisis.js';
import { MESES_VALIDOS, construirCalendario } from '../proveedores/domain/calendario.js';
import { calcularPrevision } from '../proveedores/domain/prevision.js';
import { importarZip } from '../proveedores/importar-zip.js';
import { generarCalendarioPdf } from '../proveedores/pdf/calendario.js';
import {
  actualizarDocumento,
  actualizarProveedor,
  adjuntarJustificanteDocumento,
  adjuntarJustificantePago,
  asociarDocumentos,
  crearDocumento,
  desasociarDocumentos,
  docDePago,
  eliminarDocumento,
  eliminarPago,
  leerArchivo,
  listarDocumentos,
  listarProveedores,
  obtenerDocumento,
  registrarPago,
  resumen,
  sustituirArchivo,
  vencimientosParaCalendario,
  vencimientosPendientes,
  withTransaction,
} from '../proveedores/repo.js';
import { auditFrom } from '../services/audit.js';
import { cleanFilename, MAX_FILE_BYTES } from '../services/expense-files.js';
import { formatEuros } from '../services/money.js';
import { todayInShop } from '../services/vacation-balance.js';

// API de «Gestionar pagos a proveedores» (antes «Control de facturas»).
// Mantiene las rutas y respuestas de la app original bajo /api/proveedores.

const MAX_ZIP_BYTES = 150 * 1024 * 1024;
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const rawFile = express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 });
const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const docLabel = (d) => `${d.tipo === 'pedido' ? 'Pedido' : 'Factura'} ${d.numero} · ${d.proveedor.nombre}`;

function readId(value, label = 'Ese documento') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, `${label} no existe.`, 'NOT_FOUND');
  return id;
}

/** Archivo subido en crudo (cuerpo = archivo; nombre en X-File-Name). */
function upload(req) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Falta el archivo.', 'NO_FILE');
  return { data: req.body, filename: req.get('X-File-Name'), mime: req.get('Content-Type') };
}

function hasFile(req) {
  return Buffer.isBuffer(req.body) && req.body.length > 0;
}

const DOC_FIELDS = Object.freeze({
  numero: 'Número', fecha: 'Fecha', total: 'Total', forma_pago: 'Forma de pago', fecha_entrega: 'Fecha de entrega',
  pedidos: 'Pedidos', albaranes: 'Albaranes', notas: 'Notas', estado_manual: 'Estado del pedido', vencimientos: 'Vencimientos', proveedor: 'Proveedor',
});

function docSnapshot(d) {
  return {
    numero: d.numero,
    fecha: esDate(d.fecha),
    total: formatEuros(d.total_cent),
    forma_pago: d.forma_pago,
    fecha_entrega: d.fecha_entrega ? esDate(d.fecha_entrega) : null,
    pedidos: d.pedidos.join(', ') || null,
    albaranes: d.albaranes.join(', ') || null,
    notas: d.notas,
    estado_manual: d.estado_manual,
    vencimientos: d.vencimientos.map((v) => `${esDate(v.fecha)} ${formatEuros(v.importe_cent)}`).join(' · ') || null,
    proveedor: d.proveedor.nombre,
  };
}

function diffDocs(before, after) {
  const a = docSnapshot(before);
  const b = docSnapshot(after);
  return Object.entries(DOC_FIELDS)
    .filter(([k]) => (a[k] ?? null) !== (b[k] ?? null))
    .map(([k, field]) => ({ field, from: a[k] ?? null, to: b[k] ?? null }));
}

export function proveedoresRouter({ pool, config, log = console }) {
  const router = Router();
  const audit = auditFrom(pool, log);
  const settings = config.proveedores;
  // Lo que cambia algo: Administrador y Empleado (el Asesor ya lo tiene bloqueado antes).
  const canWrite = requireRole('admin', 'empleado');

  // Los PDF analizados y no confirmados se limpian al arrancar y de vez en cuando.
  limpiarTemporales(pool).catch((error) => log.error('[proveedores] Limpieza de temporales:', error.message));

  router.get('/config', (_req, res) => res.json({ ok: true, data: configPublica(settings) }));

  /* ---------- Importar PDF ---------- */

  // Un PDF por petición (el navegador los manda de uno en uno, hasta 30).
  router.post('/analizar', canWrite, rawFile, handle(async (req, res) => {
    res.json({ ok: true, data: await analizarPdf(pool, upload(req), { userId: req.user.id, settings }) });
  }));

  router.delete('/analizar/:tempId', canWrite, handle(async (req, res) => {
    await descartarTemporal(pool, req.params.tempId, req.user.id);
    res.json({ ok: true });
  }));

  /* ---------- Documentos ---------- */

  router.get('/documentos', handle(async (req, res) => {
    const { tipo, proveedor_id: proveedorId, estado, q, desde, hasta } = req.query;
    res.json({ ok: true, data: await listarDocumentos(pool, { tipo, proveedor_id: proveedorId, estado, q, desde, hasta }) });
  }));

  router.post('/documentos', canWrite, handle(async (req, res) => {
    const { tempId, ...datos } = req.body ?? {};
    // En una sola transacción: si el alta falla (fecha mal escrita, número
    // repetido…), el PDF analizado sigue esperando y se puede corregir y reintentar.
    const { doc, archivo } = await withTransaction(pool, async (client) => {
      const file = await consolidarArchivo(client, tempId, req.user.id);
      return { archivo: file, doc: await crearDocumento(client, datos, file, { userId: req.user.id }) };
    });
    await audit(req, {
      area: 'proveedores',
      action: 'crear',
      target: docLabel(doc),
      changes: [
        { field: 'Total', from: null, to: formatEuros(doc.total_cent) },
        ...(doc.tipo === 'factura' ? [{ field: 'Vencimientos', from: null, to: docSnapshot(doc).vencimientos }] : []),
        ...(archivo ? [{ field: 'PDF', from: null, to: archivo.nombre }] : []),
      ],
    });
    res.status(201).json({ ok: true, data: doc });
  }));

  router.get('/documentos/:id', handle(async (req, res) => {
    res.json({ ok: true, data: await obtenerDocumento(pool, readId(req.params.id)) });
  }));

  router.put('/documentos/:id', canWrite, handle(async (req, res) => {
    const { before, after } = await actualizarDocumento(pool, readId(req.params.id), req.body ?? {});
    const changes = diffDocs(before, after);
    if (changes.length) await audit(req, { area: 'proveedores', action: 'editar', target: docLabel(after), changes });
    res.json({ ok: true, data: after });
  }));

  router.delete('/documentos/:id', canWrite, handle(async (req, res) => {
    const doc = await eliminarDocumento(pool, readId(req.params.id));
    await audit(req, {
      area: 'proveedores',
      action: 'borrar',
      target: docLabel(doc),
      changes: [{ field: doc.tipo === 'pedido' ? 'Pedido' : 'Factura', from: `${esDate(doc.fecha)} · ${formatEuros(doc.total_cent)}`, to: null }],
    });
    res.json({ ok: true });
  }));

  router.post('/documentos/:id/asociar', canWrite, handle(async (req, res) => {
    const { factura, pedido } = await asociarDocumentos(pool, readId(req.params.id), readId(req.body?.otro_id));
    await audit(req, { area: 'proveedores', action: 'asociar', target: docLabel(factura), changes: [{ field: 'Pedido asociado', from: null, to: pedido.numero }] });
    res.json({ ok: true, data: factura });
  }));

  router.delete('/documentos/:facturaId/asociar/:pedidoId', canWrite, handle(async (req, res) => {
    const { factura, pedido } = await desasociarDocumentos(pool, readId(req.params.facturaId), readId(req.params.pedidoId));
    await audit(req, { area: 'proveedores', action: 'asociar', target: docLabel(factura), changes: [{ field: 'Pedido asociado', from: pedido.numero, to: null }] });
    res.json({ ok: true, data: factura });
  }));

  router.get('/documentos/:id/archivo', handle(async (req, res) => {
    const doc = await obtenerDocumento(pool, readId(req.params.id));
    if (!doc.archivo) throw new HttpError(404, 'Este documento no tiene PDF adjunto.', 'NO_FILE');
    sendStoredFile(res, await leerArchivo(pool, doc.archivo), { download: req.query.descargar === '1' });
  }));

  router.post('/documentos/:id/adjuntar', canWrite, rawFile, handle(async (req, res) => {
    const id = readId(req.params.id);
    await obtenerDocumento(pool, id);
    const archivo = await guardarSubida(pool, upload(req), { soloPdf: true });
    const { before, after } = await sustituirArchivo(pool, id, archivo);
    await audit(req, { area: 'proveedores', action: 'subir', target: docLabel(after), changes: [{ field: 'PDF', from: before.archivo_nombre, to: after.archivo_nombre }] });
    res.json({ ok: true, data: after });
  }));

  /* ---------- Pagos ---------- */

  // Cuerpo: el justificante en crudo (opcional); datos en la consulta:
  // ?vencimiento_id=…&fecha=AAAA-MM-DD&notas=…  (sin vencimiento_id = toda la factura).
  router.post('/documentos/:id/pagar', canWrite, rawFile, handle(async (req, res) => {
    const id = readId(req.params.id);
    const datos = hasFile(req) || Buffer.isBuffer(req.body) ? req.query : { ...req.query, ...(req.body ?? {}) };
    await obtenerDocumento(pool, id);
    const archivo = hasFile(req) ? await guardarSubida(pool, upload(req)) : null;
    const { doc, pagados, fecha } = await registrarPago(pool, id, {
      vencimiento_id: datos.vencimiento_id || null,
      fecha: datos.fecha,
      notas: datos.notas,
    }, archivo?.fileId ?? null, req.user.id).catch(async (error) => {
      if (archivo) await pool.query('DELETE FROM supplier_files WHERE id = $1', [archivo.fileId]);
      throw error;
    });
    await audit(req, {
      area: 'proveedores',
      action: 'pagar',
      target: docLabel(doc),
      changes: pagados.map((v) => ({ field: `Vencimiento ${esDate(v.fecha)}`, from: `Pendiente ${formatEuros(v.importe_cent)}`, to: `Pagado el ${esDate(fecha)}${archivo ? ' con justificante' : ''}` })),
    });
    res.status(201).json({ ok: true, data: doc });
  }));

  router.post('/documentos/:id/justificante', canWrite, rawFile, handle(async (req, res) => {
    const id = readId(req.params.id);
    await obtenerDocumento(pool, id);
    const archivo = await guardarSubida(pool, upload(req));
    const doc = await adjuntarJustificanteDocumento(pool, id, archivo.fileId);
    await audit(req, { area: 'proveedores', action: 'subir', target: docLabel(doc), changes: [{ field: 'Justificante', from: null, to: cleanFilename(req.get('X-File-Name')) }] });
    res.json({ ok: true, data: doc });
  }));

  router.post('/pagos/:id/justificante', canWrite, rawFile, handle(async (req, res) => {
    const pagoId = readId(req.params.id, 'Ese pago');
    await docDePago(pool, pagoId);
    const archivo = await guardarSubida(pool, upload(req));
    const doc = await adjuntarJustificantePago(pool, pagoId, archivo.fileId);
    await audit(req, { area: 'proveedores', action: 'subir', target: docLabel(doc), changes: [{ field: 'Justificante del pago', from: null, to: cleanFilename(req.get('X-File-Name')) }] });
    res.json({ ok: true, data: doc });
  }));

  router.delete('/pagos/:id', canWrite, handle(async (req, res) => {
    const { doc, pago } = await eliminarPago(pool, readId(req.params.id, 'Ese pago'));
    await audit(req, {
      area: 'proveedores',
      action: 'anular_pago',
      target: docLabel(doc),
      changes: [{ field: `Vencimiento ${esDate(pago.vence)}`, from: `Pagado el ${esDate(pago.fecha)} (${formatEuros(pago.amount_cents)})`, to: 'Pendiente' }],
    });
    res.json({ ok: true, data: doc });
  }));

  router.get('/pagos/:id/archivo', handle(async (req, res) => {
    const { file_id: fileId } = await docDePago(pool, readId(req.params.id, 'Ese pago'));
    if (!fileId) throw new HttpError(404, 'Este pago no tiene justificante.', 'NO_FILE');
    sendStoredFile(res, await leerArchivo(pool, fileId), { download: req.query.descargar === '1' });
  }));

  /* ---------- Proveedores ---------- */

  router.get('/lista', handle(async (_req, res) => {
    res.json({ ok: true, data: await listarProveedores(pool) });
  }));

  router.put('/lista/:id', canWrite, handle(async (req, res) => {
    const { before, after } = await actualizarProveedor(pool, readId(req.params.id, 'Ese proveedor'), req.body ?? {});
    const changes = [['nombre', 'Nombre'], ['cif', 'CIF'], ['notas', 'Notas']]
      .filter(([k]) => (before[k] ?? null) !== (after[k] ?? null))
      .map(([k, field]) => ({ field, from: before[k], to: after[k] }));
    if (changes.length) await audit(req, { area: 'proveedores', action: 'editar', target: `Proveedor ${after.nombre}`, changes });
    res.json({ ok: true, data: after });
  }));

  /* ---------- Previsión, resumen y calendario ---------- */

  router.get('/prevision', handle(async (req, res) => {
    const meses = Math.min(12, Math.max(1, Number(req.query.meses) || 3));
    res.json({ ok: true, data: calcularPrevision(await vencimientosPendientes(pool), { hoy: todayInShop(), meses }) });
  }));

  router.get('/resumen', handle(async (_req, res) => {
    res.json({ ok: true, data: await resumen(pool) });
  }));

  // Calendario de pagos en PDF: 3, 6 o 9 meses contando el actual.
  router.get('/calendario.pdf', handle(async (req, res) => {
    const hoy = todayInShop();
    const meses = MESES_VALIDOS.includes(Number(req.query.meses)) ? Number(req.query.meses) : 3;
    const { desde, hasta } = construirCalendario([], { hoy, meses });
    const pdf = generarCalendarioPdf(await vencimientosParaCalendario(pool, { desde, hasta }), {
      hoy, meses, titulo: 'Calendario de pagos', subtitulo: 'Calzando Sueños · Puntapié',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.ver === '1' ? 'inline' : 'attachment'}; filename="calendario-pagos-${meses}m-${hoy}.pdf"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(pdf);
  }));

  router.get('/export.csv', handle(async (req, res) => {
    const tipo = req.query.tipo === 'pedido' ? 'pedido' : req.query.tipo === 'factura' ? 'factura' : undefined;
    const docs = await listarDocumentos(pool, { tipo });
    const eur = (c) => (c / 100).toFixed(2).replace('.', ',');
    const filas = [['Tipo', 'Proveedor', 'Número', 'Fecha', 'Total', 'Pendiente', 'Estado', 'Vencimientos', 'Pedidos', 'Albaranes', 'Fecha entrega', 'Forma de pago']];
    for (const d of docs) {
      filas.push([d.tipo, d.proveedor.nombre, d.numero, d.fecha ?? '', eur(d.total_cent), eur(d.pendiente_cent), d.estado,
        d.vencimientos.map((v) => `${v.fecha} ${eur(v.importe_cent)}${v.pago ? ' (pagado)' : ''}`).join(' | '),
        d.pedidos.join(' '), d.albaranes.join(' '), d.fecha_entrega ?? '', d.forma_pago ?? '']);
    }
    // Celdas que empiezan por = + - @ se neutralizan para que Excel no las ejecute como fórmula.
    const cell = (c) => `"${String(c).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;
    const csv = filas.map((f) => f.map(cell).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tipo ?? 'documentos'}-proveedores-${todayInShop()}.csv"`);
    res.send(`﻿${csv}`);
  }));

  /* ---------- Importar la app antigua ---------- */

  // ZIP exportado de «Control de facturas». Solo el Administrador; se puede repetir sin duplicar.
  router.post('/importar-zip', requireRole('admin'), express.raw({ type: () => true, limit: MAX_ZIP_BYTES }), handle(async (req, res) => {
    const result = await importarZip(pool, upload(req).data, { userId: req.user.id });
    await audit(req, {
      area: 'proveedores',
      action: 'importar',
      target: 'Copia de «Control de facturas»',
      changes: [{ field: 'Importado', from: null, to: `${result.facturas} facturas, ${result.pedidos} pedidos, ${result.pagos} pagos (${result.yaEstaban} ya estaban)` }],
    });
    res.json({ ok: true, data: result });
  }));

  router.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande.', code: 'FILE_TOO_LARGE' });
    }
    return next(error);
  });
  router.use(httpErrorHandler);
  return router;
}
