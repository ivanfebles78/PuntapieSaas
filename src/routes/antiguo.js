import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { HttpError, httpErrorHandler } from '../http-error.js';
import { antiguoConfigurado, conectarAntiguo, ErrorAntiguo } from '../antiguo/cliente.js';
import { sincronizarConCandado } from '../antiguo/programador.js';
import { describir } from '../antiguo/registros.js';
import { resolverItem } from '../antiguo/resolver.js';
import { COLUMNAS } from '../antiguo/sincronizar.js';
import { auditFrom } from '../services/audit.js';
import { formatEuros } from '../services/money.js';

// Admin › Sistema antiguo: estado de la sincronización con gestiondegastos,
// «Sincronizar ahora» y lo que queda por decidir (cambios y archivos).

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const VISTAS = Object.freeze({
  cambios: "state = 'cambio'",
  revisar: "state = 'revisar'",
  traidos: "state = 'importado'",
  ignorados: "(state = 'ignorado' OR reason LIKE 'Ya estaba%')",
});
const MAX_FILAS = 300;
const ACCIONES = Object.freeze({
  actualizar: 'Actualizado con lo del antiguo', mantener: 'Se mantiene lo del nuevo', ignorar: 'Ignorado',
  quitar: 'Quitado', traer: 'Traído igualmente', asignar: 'Archivo asignado',
});

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new HttpError(404, 'Ese registro no existe.', 'NOT_FOUND');
  return id;
}

const publico = (r) => ({
  id: r.id, origen: r.source, estado: r.state, dia: r.day,
  motivo: r.reason, gasto_id: r.expense_id, archivo_id: r.file_id, actualizado: r.updated_at, ...describir(r),
});

/** Gastos del mes del archivo a los que se puede pegar (los del mismo día, primero). */
async function candidatos(pool, item) {
  const dia = String(item.data.sale_date).slice(0, 10);
  const mes = `${dia.slice(0, 7)}-01`;
  const rows = (await pool.query(
    `SELECT e.id, e.name, e.category, to_char(e.expense_date, 'YYYY-MM-DD') AS fecha,
            COALESCE(en.amount_cents, (SELECT a.amount_cents FROM recurring_amounts a WHERE a.expense_id = e.id AND a.from_month <= $1
                                       ORDER BY a.from_month DESC LIMIT 1), 0) AS cents
       FROM recurring_expenses e LEFT JOIN recurring_entries en ON en.expense_id = e.id AND en.month = $1
      WHERE e.category <> 'proveedor' AND e.start_month <= $1 AND (e.end_month IS NULL OR e.end_month >= $1)
      ORDER BY (e.expense_date = $2::date) DESC NULLS LAST, e.expense_date NULLS FIRST, lower(e.name)`,
    [mes, dia],
  )).rows;
  return rows.map((r) => ({
    id: r.id, nombre: r.name, fecha: r.fecha, importe: formatEuros(r.cents), mismo_dia: r.fecha === dia,
  }));
}

export function antiguoRouter({ pool, config, log = console, fetchImpl = fetch }) {
  const router = Router();
  const admin = requireRole('admin');
  const audit = auditFrom(pool, log);
  const conectar = () => conectarAntiguo(config.antiguo, fetchImpl);
  const configurado = () => antiguoConfigurado(config);

  router.get('/estado', handle(async (_req, res) => {
    const ultima = (await pool.query(
      `SELECT r.origin, r.started_at, r.finished_at, r.summary, r.error, u.name AS usuario
         FROM legacy_runs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.started_at DESC LIMIT 1`,
    )).rows[0] ?? null;
    const n = (await pool.query(
      `SELECT count(*) FILTER (WHERE ${VISTAS.cambios})::int AS cambios, count(*) FILTER (WHERE ${VISTAS.revisar})::int AS revisar,
              count(*) FILTER (WHERE ${VISTAS.traidos})::int AS traidos, count(*) FILTER (WHERE ${VISTAS.ignorados})::int AS ignorados
         FROM legacy_items`,
    )).rows[0];
    res.json({
      ok: true,
      data: {
        configurado: configurado(),
        direccion: config.antiguo.url,
        hora: config.antiguo.hora,
        contadores: n,
        ultima: ultima && {
          origen: ultima.origin, usuario: ultima.usuario, inicio: ultima.started_at, fin: ultima.finished_at, resumen: ultima.summary, error: ultima.error,
        },
      },
    });
  }));

  router.post('/sincronizar', admin, handle(async (req, res) => {
    if (!configurado()) {
      throw new HttpError(409, 'Falta conectar gestiondegastos: añade GESTIONGASTOS_USUARIO y GESTIONGASTOS_CLAVE en Railway.', 'LEGACY_OFF');
    }
    let r;
    try {
      r = await sincronizarConCandado(pool, { config, origen: 'manual', userId: req.user.id, fetchImpl, log });
    } catch (error) {
      if (error instanceof ErrorAntiguo) throw new HttpError(502, error.message, 'LEGACY_ERROR');
      throw error;
    }
    if (!r) throw new HttpError(409, 'Ya se está sincronizando; espera un momento.', 'LEGACY_BUSY');
    await audit(req, { area: 'ventas', action: 'crear', target: 'Sincronización con gestiondegastos', changes: [
      { field: 'Traído', from: null, to: `${r.dias} días, ${r.gastos} gastos, ${r.mensuales} mensuales, ${r.adjuntos} archivos` },
    ] });
    res.json({ ok: true, data: r });
  }));

  router.get('/items', handle(async (req, res) => {
    const vista = String(req.query.vista ?? 'cambios');
    if (!VISTAS[vista]) throw new HttpError(400, 'Vista no válida.', 'INVALID_VIEW');
    const rows = (await pool.query(
      `SELECT ${COLUMNAS} FROM legacy_items WHERE ${VISTAS[vista]} ORDER BY day DESC NULLS LAST, id DESC LIMIT ${MAX_FILAS}`,
    )).rows;
    const data = [];
    for (const r of rows) {
      data.push({ ...publico(r), ...(vista === 'revisar' && r.source === 'adjunto' ? { gastos: await candidatos(pool, r) } : {}) });
    }
    res.json({ ok: true, data });
  }));

  // Ver el archivo antes de asignarlo: se pide al antiguo en el momento.
  router.get('/items/:id/archivo', handle(async (req, res) => {
    const r = (await pool.query(`SELECT ${COLUMNAS} FROM legacy_items WHERE id = $1 AND source = 'adjunto'`, [readId(req.params.id)])).rows[0];
    if (!r) throw new HttpError(404, 'Ese archivo no existe.', 'NOT_FOUND');
    if (!configurado()) throw new HttpError(409, 'Falta conectar gestiondegastos.', 'LEGACY_OFF');
    let archivo;
    try {
      archivo = await (await conectar()).archivo(r.legacy_id);
    } catch (error) {
      if (error instanceof ErrorAntiguo) throw new HttpError(502, error.message, 'LEGACY_ERROR');
      throw error;
    }
    if (!archivo) throw new HttpError(410, 'El archivo ya no está en el servidor antiguo.', 'GONE');
    const seguro = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(archivo.mime) ? archivo.mime : 'application/octet-stream';
    res.setHeader('Content-Type', seguro);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.data.original_filename ?? 'archivo')}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(archivo.data);
  }));

  router.post('/items/:id', admin, handle(async (req, res) => {
    const accion = String(req.body?.accion ?? '');
    let resultado;
    try {
      resultado = await resolverItem(pool, readId(req.params.id), {
        accion, gastoId: req.body?.gasto_id, tipo: req.body?.tipo, userId: req.user.id, fuente: conectar,
      });
    } catch (error) {
      if (error instanceof ErrorAntiguo) throw new HttpError(502, error.message, 'LEGACY_ERROR');
      throw error;
    }
    const { antes, despues } = resultado;
    const { titulo, detalle } = describir(despues);
    await audit(req, {
      area: antes.source === 'dia' ? 'ventas' : 'gastos',
      action: accion === 'quitar' ? 'borrar' : 'editar',
      target: `Sistema antiguo · ${titulo} (${detalle})`,
      changes: [{ field: ACCIONES[accion] ?? accion, from: antes.reason, to: despues.reason }],
    });
    res.json({ ok: true, data: publico(despues) });
  }));

  router.use(httpErrorHandler);
  return router;
}
