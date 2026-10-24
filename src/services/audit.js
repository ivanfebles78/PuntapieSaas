import { HttpError } from '../http-error.js';

// Log de acciones: quién hizo qué, cuándo, y qué valor tenía antes y después.
// Se escribe desde las rutas, después de que la acción haya salido bien.

export const AUDIT_AREAS = Object.freeze({
  sesion: 'Sesión',
  usuarios: 'Usuarios',
  vacaciones: 'Vacaciones',
  turnos: 'Turnos',
  aperturas: 'Aperturas extra',
  horas: 'Horas bonificadas',
  gastos: 'Gastos',
  proveedores: 'Pagos a proveedores',
  ventas: 'Ventas',
  objetivos: 'Objetivos de venta',
});

export const AUDIT_ACTIONS = Object.freeze({
  entrar: 'Inicio de sesión',
  entrar_fallido: 'Intento de acceso fallido',
  salir: 'Cierre de sesión',
  cambiar_contrasena: 'Cambio de contraseña',
  pedir_enlace: 'Solicitud de enlace de contraseña',
  restablecer: 'Contraseña restablecida',
  crear: 'Alta',
  editar: 'Cambio',
  borrar: 'Borrado',
  baja: 'Baja',
  reactivar: 'Reactivación',
  enviar_acceso: 'Envío de enlace de acceso',
  contrasena_provisional: 'Contraseña provisional',
  subir: 'Documento subido',
  quitar: 'Documento quitado',
  exportar: 'Exportación',
  pagar: 'Pago registrado',
  anular_pago: 'Pago anulado',
  asociar: 'Asociación',
  importar: 'Importación',
});

const MAX_TEXT = 500;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 100000;

const clip = (value) => {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

/**
 * Guarda una acción. `changes` = [{ field, from, to }]; sin cambios, una sola
 * fila sin campo. `actor` es el usuario de la sesión ({ id, name }) o null.
 */
export async function recordAudit(db, { actor, area, action, target = '', changes = [], ip = null }) {
  const rows = changes.length ? changes : [{ field: null, from: null, to: null }];
  const values = [];
  const params = [];
  rows.forEach((change, i) => {
    const base = i * 9;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`);
    params.push(actor?.id ?? null, actor?.name ?? '', area, action, clip(target) ?? '', change.field ?? null, clip(change.from), clip(change.to), ip);
  });
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, area, action, target, field, old_value, new_value, ip)
     VALUES ${values.join(', ')}`,
    params,
  );
}

/** Solo los campos que de verdad cambian, con sus etiquetas. */
export function diffFields(before, after, labels) {
  return Object.entries(labels)
    .filter(([key]) => after[key] !== undefined && (before[key] ?? null) !== (after[key] ?? null))
    .map(([key, label]) => ({ field: label, from: before[key] ?? null, to: after[key] ?? null }));
}

/** Atajo para las rutas: toma actor e IP de la petición y nunca rompe la respuesta. */
export function auditFrom(pool, log = console) {
  return async (req, entry) => {
    try {
      await recordAudit(pool, { actor: req.user, ip: req.ip ?? null, ...entry });
    } catch (error) {
      log.error('[audit] No se pudo guardar la acción:', error.message);
    }
  };
}

function readFilters(query) {
  const filters = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    filters.push(sql.replace('?', `$${params.length}`));
  };
  if (query.usuario) {
    const id = Number(query.usuario);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Usuario no válido.', 'INVALID_FILTER');
    add('user_id = ?', id);
  }
  if (query.area) {
    if (!Object.hasOwn(AUDIT_AREAS, query.area)) throw new HttpError(400, 'Sección no válida.', 'INVALID_FILTER');
    add('area = ?', query.area);
  }
  if (query.accion) {
    if (!Object.hasOwn(AUDIT_ACTIONS, query.accion)) throw new HttpError(400, 'Tipo de acción no válido.', 'INVALID_FILTER');
    add('action = ?', query.accion);
  }
  for (const [key, sql] of [['desde', "at >= (?::date)::timestamp AT TIME ZONE 'Atlantic/Canary'"], ['hasta', "at < (?::date + 1)::timestamp AT TIME ZONE 'Atlantic/Canary'"]]) {
    if (!query[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || Number.isNaN(Date.parse(query[key]))) {
      throw new HttpError(400, 'Fecha no válida.', 'INVALID_FILTER');
    }
    add(sql, query[key]);
  }
  if (query.q) {
    const text = `%${String(query.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add("(user_name ILIKE ? OR target ILIKE $N OR field ILIKE $N OR old_value ILIKE $N OR new_value ILIKE $N)", text);
    filters[filters.length - 1] = filters[filters.length - 1].replaceAll('$N', `$${params.length}`);
  }
  return { where: filters.length ? `WHERE ${filters.join(' AND ')}` : '', params };
}

/** Página del log, lo más reciente primero. */
export async function listAudit(pool, query = {}) {
  const { where, params } = readFilters(query);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.limite)) || PAGE_SIZE));
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(query.pagina, 10) || 1));
  const total = await pool.query(`SELECT count(*)::int AS n FROM audit_log ${where}`, params);
  const rows = await pool.query(
    `SELECT id, at, user_id, user_name, area, action, target, field, old_value, new_value, ip
       FROM audit_log ${where}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  );
  return {
    items: rows.rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      userId: r.user_id,
      userName: r.user_name,
      area: r.area,
      action: r.action,
      target: r.target,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      ip: r.ip,
    })),
    page,
    pageSize: limit,
    total: total.rows[0].n,
    areas: AUDIT_AREAS,
    actions: AUDIT_ACTIONS,
  };
}
