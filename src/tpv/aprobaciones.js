// Aprobaciones de un Administrador en el TPV: descuentos de más del 15 % y
// cierres de caja que no cuadran. Se aprueban en persona (usuario y contraseña
// en la propia caja) o a distancia (aviso por WhatsApp con un enlace). Cada
// aprobación vale para lo que se pidió, una sola vez y durante 30 minutos.
import { generateToken, hashToken } from '../auth/tokens.js';
import { HttpError } from '../http-error.js';

const VALIDEZ_MIN = 30;
const TZ = 'Atlantic/Canary';

const resumenLineas = (calculo) => calculo.lineas.map((l) => ({
  descripcion: l.descripcion, talla: l.talla, cantidad: l.cantidad, bruto_cent: l.bruto_cent, total_cent: l.total_cent,
}));

/**
 * Crea la solicitud. Descuento: `{ calculo }`. Cierre: `{ cierre: { sesionId, esperado, contado } }`
 * (en subtotal va lo esperado y en total lo contado). Devuelve { id, token }:
 * el token solo existe aquí, en la base va su hash.
 */
export async function crearSolicitud(db, { calculo = null, cierre = null, solicitante, canal, estado = 'pendiente', decididoPor = null }) {
  const token = generateToken();
  const valores = cierre
    ? { kind: 'cierre', pct: 0, sub: cierre.esperado, total: cierre.contado, resumen: [], sesion: cierre.sesionId }
    : { kind: 'descuento', pct: Math.min(100, Math.max(0.1, calculo.pct_descuento)), sub: calculo.subtotal_cent, total: calculo.total_cent, resumen: resumenLineas(calculo), sesion: null };
  const r = (await db.query(
    `INSERT INTO tpv_discount_requests (token_hash, requested_by, channel, percent, subtotal_cents, total_cents, summary, status, decided_by,
                                        decided_at, expires_at, kind, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() END, NOW() + make_interval(mins => $10), $11, $12)
     RETURNING id`,
    [hashToken(token), solicitante.id, canal, valores.pct, valores.sub, valores.total, JSON.stringify(valores.resumen), estado, decididoPor,
      VALIDEZ_MIN, valores.kind, valores.sesion],
  )).rows[0];
  return { id: r.id, token };
}

export async function marcarAvisada(db, id, como) {
  await db.query('UPDATE tpv_discount_requests SET notified = $2 WHERE id = $1', [id, como]);
}

const publica = (r) => ({
  id: r.id, tipo: r.kind, estado: r.status, canal: r.channel, pct: Number(r.percent),
  // En un cierre: subtotal = esperado y total = contado.
  subtotal_cent: r.subtotal_cents, total_cent: r.total_cents,
  lineas: r.summary, solicitante: r.solicitante, decidido_por: r.decisor, creada: r.creada, caducada: r.caducada,
});

const SELECT = `
  SELECT d.*, u.name AS solicitante, a.name AS decisor, to_char(d.created_at AT TIME ZONE '${TZ}', 'DD/MM HH24:MI') AS creada,
         (d.expires_at < NOW()) AS caducada
    FROM tpv_discount_requests d JOIN users u ON u.id = d.requested_by LEFT JOIN users a ON a.id = d.decided_by`;

const conCaducidad = (r) => publica({ ...r, status: r.status === 'pendiente' && r.caducada ? 'caducado' : r.status });

/** Estado de una solicitud para quien la pidió (la caja la consulta mientras espera). */
export async function estadoSolicitud(db, id, usuario) {
  const r = (await db.query(`${SELECT} WHERE d.id = $1`, [id])).rows[0];
  if (!r || (r.requested_by !== usuario.id && usuario.role !== 'admin')) throw new HttpError(404, 'Esa solicitud no existe.', 'REQUEST_NOT_FOUND');
  return conCaducidad(r);
}

/** La solicitud que abre el Administrador desde el enlace del WhatsApp. */
export async function solicitudPorToken(db, token) {
  const r = (await db.query(`${SELECT} WHERE d.token_hash = $1`, [hashToken(String(token ?? ''))])).rows[0];
  if (!r) throw new HttpError(404, 'Esta solicitud no existe o el enlace no es correcto.', 'REQUEST_NOT_FOUND');
  return conCaducidad(r);
}

export async function decidir(db, token, { aprobar, admin }) {
  const r = (await db.query(
    `UPDATE tpv_discount_requests SET status = $2, decided_by = $3, decided_at = NOW(),
            expires_at = CASE WHEN $2 = 'aprobado' THEN NOW() + make_interval(mins => $4) ELSE expires_at END
      WHERE token_hash = $1 AND status = 'pendiente' AND expires_at >= NOW() RETURNING id`,
    [hashToken(String(token ?? '')), aprobar ? 'aprobado' : 'rechazado', admin.id, VALIDEZ_MIN],
  )).rows[0];
  if (!r) throw new HttpError(409, 'Esta solicitud ya no está pendiente (ya se decidió o ha caducado).', 'REQUEST_CLOSED');
  return conCaducidad((await db.query(`${SELECT} WHERE d.id = $1`, [r.id])).rows[0]);
}

/**
 * Comprueba que la aprobación sirve para esta venta: de quien vende, aprobada,
 * sin usar, en plazo, con el mismo subtotal y al menos el % que se aplica.
 */
export async function comprobarAprobacion(db, id, { calculo, vendedor }) {
  const r = (await db.query('SELECT * FROM tpv_discount_requests WHERE id = $1 FOR UPDATE', [Number(id) || 0])).rows[0];
  const vale = r && r.kind === 'descuento' && r.requested_by === vendedor.id && r.status === 'aprobado' && new Date(r.expires_at) >= new Date()
    && r.subtotal_cents === calculo.subtotal_cent && Number(r.percent) + 0.1 >= calculo.pct_descuento;
  if (!vale) throw new HttpError(403, 'El descuento de más del 15 % necesita la aprobación de un Administrador para esta venta.', 'DISCOUNT_NEEDS_APPROVAL');
  return r.id;
}
