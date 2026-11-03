import { HttpError } from '../http-error.js';

// Historial del asistente de correo (Admin): cada correo que revisó, si lo
// marcó como leído y cuándo, y qué hizo con cada PDF (factura nueva, gasto
// actualizado, ya estaba, para revisar…), enlazado a lo que registró.

const PAGE_SIZE = 25;
const MAX_PAGE = 1000;
const MAX_RUNS = 10;

/** Qué supuso cada PDF, en una palabra. */
export const RESULTADOS = Object.freeze({
  factura: 'Factura nueva',
  gasto: 'Gasto actualizado',
  ya_estaba: 'Ya estaba',
  revisar: 'Para revisar',
  a_mano: 'Resuelto a mano',
  descartado: 'Descartado',
});

/** Filtro de correos por lo que hizo el asistente. */
export const FILTROS = Object.freeze({
  registro: 'Registró una factura o un gasto',
  pendiente: 'Queda algo por revisar',
  a_mano: 'Resuelto a mano',
  nada: 'No registró nada',
});

const FILTRO_SQL = Object.freeze({
  registro: "EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND a.state IN ('creado', 'productos'))",
  pendiente: "EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND a.state IN ('revisar', 'productos'))",
  a_mano: "EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND a.state = 'hecho')",
  nada: "NOT EXISTS (SELECT 1 FROM mail_attachments a WHERE a.message_ref = m.id AND a.state IN ('creado', 'productos', 'hecho'))",
});

function resultado(a) {
  if (a.state === 'creado' || a.state === 'productos') return a.kind === 'gasto' ? 'gasto' : 'factura';
  if (a.state === 'ignorado') return 'ya_estaba';
  if (a.state === 'hecho') return 'a_mano';
  return a.state === 'descartado' ? 'descartado' : 'revisar';
}

function readFilters(query) {
  const params = [];
  const filters = [];
  const add = (sql, value) => {
    params.push(value);
    filters.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (query.resultado) {
    if (!Object.hasOwn(FILTRO_SQL, query.resultado)) throw new HttpError(400, 'Filtro no válido.', 'INVALID_FILTER');
    filters.push(FILTRO_SQL[query.resultado]);
  }
  if (query.leido) {
    if (!['si', 'no'].includes(query.leido)) throw new HttpError(400, 'Filtro no válido.', 'INVALID_FILTER');
    filters.push(query.leido === 'si' ? 'm.marked_read' : 'NOT m.marked_read');
  }
  for (const [key, sql] of [
    ['desde', "COALESCE(m.sent_at, m.created_at) >= (?::date)::timestamp AT TIME ZONE 'Atlantic/Canary'"],
    ['hasta', "COALESCE(m.sent_at, m.created_at) < (?::date + 1)::timestamp AT TIME ZONE 'Atlantic/Canary'"],
  ]) {
    if (!query[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || Number.isNaN(Date.parse(query[key]))) throw new HttpError(400, 'Fecha no válida.', 'INVALID_FILTER');
    add(sql, query[key]);
  }
  if (query.q) {
    const text = `%${String(query.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add(`(m.from_addr ILIKE ? OR m.subject ILIKE ? OR EXISTS (
            SELECT 1 FROM mail_attachments a
              LEFT JOIN supplier_docs d ON d.id = a.doc_id LEFT JOIN suppliers s ON s.id = d.supplier_id
              LEFT JOIN recurring_expenses e ON e.id = a.expense_id
             WHERE a.message_ref = m.id AND (a.filename ILIKE ? OR a.reason ILIKE ? OR d.number ILIKE ? OR s.name ILIKE ? OR e.name ILIKE ?)))`, text);
  }
  return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
}

async function adjuntosDe(pool, ids) {
  if (!ids.length) return new Map();
  const rows = (await pool.query(
    `SELECT a.id, a.message_ref, a.filename, a.kind, a.state, a.reason, a.resolved_at, a.doc_id, a.expense_id,
            to_char(a.month, 'YYYY-MM') AS mes,
            d.kind AS doc_kind, d.number AS doc_number, d.total_cents AS doc_total, to_char(d.doc_date, 'DD/MM/YYYY') AS doc_fecha,
            s.name AS proveedor, e.name AS gasto
       FROM mail_attachments a
       LEFT JOIN supplier_docs d ON d.id = a.doc_id
       LEFT JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN recurring_expenses e ON e.id = a.expense_id
      WHERE a.message_ref = ANY($1::int[])
      ORDER BY a.id`,
    [ids],
  )).rows;
  const porCorreo = new Map(ids.map((id) => [id, []]));
  for (const a of rows) {
    porCorreo.get(a.message_ref).push({
      id: a.id,
      archivo: a.filename,
      resultado: resultado(a),
      faltan_productos: a.state === 'productos',
      motivo: a.reason,
      resuelto_el: a.resolved_at,
      factura: a.doc_id ? {
        id: a.doc_id, tipo: a.doc_kind, numero: a.doc_number, proveedor: a.proveedor, total_cent: a.doc_total, fecha: a.doc_fecha,
      } : null,
      gasto: a.expense_id ? { id: a.expense_id, nombre: a.gasto, mes: a.mes } : null,
    });
  }
  return porCorreo;
}

async function totales(pool) {
  const r = (await pool.query(`
    SELECT (SELECT count(*)::int FROM mail_messages) AS correos,
           (SELECT count(*)::int FROM mail_messages WHERE marked_read) AS leidos,
           count(*) FILTER (WHERE state IN ('creado', 'productos') AND kind <> 'gasto')::int AS facturas,
           count(*) FILTER (WHERE state = 'creado' AND kind = 'gasto')::int AS gastos,
           count(*) FILTER (WHERE state IN ('revisar', 'productos'))::int AS pendientes
      FROM mail_attachments`)).rows[0];
  return r;
}

async function revisiones(pool) {
  return (await pool.query(
    `SELECT r.id, r.origin, r.started_at, r.finished_at, r.summary, r.error, u.name AS usuario
       FROM mail_runs r LEFT JOIN users u ON u.id = r.started_by
      ORDER BY r.started_at DESC LIMIT ${MAX_RUNS}`,
  )).rows.map((r) => ({
    id: r.id,
    origen: r.origin,
    usuario: r.usuario,
    inicio: r.started_at,
    fin: r.finished_at,
    error: r.error,
    correos: r.summary?.correos ?? null,
    facturas: r.summary?.proveedores ?? null,
    gastos: r.summary?.gastos ?? null,
    revisar: r.summary?.revisar ?? null,
    leidos: r.summary?.marcadosLeidos ?? null,
  }));
}

/** Página del historial, lo más reciente primero. */
export async function listarHistorial(pool, query = {}) {
  const { where, params } = readFilters(query);
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(query.pagina, 10) || 1));
  const total = (await pool.query(`SELECT count(*)::int AS n FROM mail_messages m ${where}`, params)).rows[0].n;
  const rows = (await pool.query(
    `SELECT m.id, m.from_addr, m.subject, m.sent_at, m.created_at, m.marked_read, m.read_at, r.origin
       FROM mail_messages m LEFT JOIN mail_runs r ON r.id = m.run_id
       ${where}
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    params,
  )).rows;
  const adjuntos = await adjuntosDe(pool, rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({
      id: r.id,
      de: r.from_addr,
      asunto: r.subject,
      fecha: r.sent_at,
      revisado_el: r.created_at,
      revision: r.origin,
      leido: r.marked_read,
      leido_el: r.read_at,
      documentos: adjuntos.get(r.id),
    })),
    page,
    pageSize: PAGE_SIZE,
    total,
    totales: await totales(pool),
    revisiones: page === 1 ? await revisiones(pool) : [],
    resultados: RESULTADOS,
    filtros: FILTROS,
  };
}
