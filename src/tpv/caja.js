// Caja del TPV: apertura con recuento de monedas y billetes, entradas y
// salidas de dinero, y cierre con arqueo. Lo contado al cerrar debe ser
// inicial + efectivo de las ventas + entradas − salidas; si no cuadra, el
// cierre necesita la aprobación de un Administrador.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';

// Monedas y billetes en euros, en céntimos.
export const DENOMINACIONES = Object.freeze([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]);
const MAX_PIEZAS = 100000;
const TZ = 'Atlantic/Canary';

/** { '500': 3, '2000': 2 } → recuento limpio y su total en céntimos. */
export function leerRecuento(entrada) {
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) throw new HttpError(400, 'Falta el recuento de monedas y billetes.', 'INVALID_COUNT');
  const recuento = {};
  let total = 0;
  for (const [k, v] of Object.entries(entrada)) {
    const d = Number(k);
    const n = v === '' || v == null ? 0 : Number(v);
    if (!DENOMINACIONES.includes(d)) throw new HttpError(400, `Moneda o billete no válido: ${k}.`, 'INVALID_COUNT');
    if (!Number.isInteger(n) || n < 0 || n > MAX_PIEZAS) throw new HttpError(400, 'El número de monedas o billetes no es válido.', 'INVALID_COUNT');
    if (n) {
      recuento[d] = n;
      total += d * n;
    }
  }
  return { recuento, total };
}

const hoyEnTienda = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

export async function sesionAbierta(db) {
  return (await db.query("SELECT * FROM tpv_cash_sessions WHERE status = 'abierta' LIMIT 1")).rows[0] ?? null;
}

/** El recuento con el que cerró la última caja: así la apertura viene rellena. */
export async function ultimoCierre(db) {
  return (await db.query("SELECT closing_counts, closing_cents FROM tpv_cash_sessions WHERE status = 'cerrada' ORDER BY closed_at DESC LIMIT 1")).rows[0] ?? null;
}

/** TPV y Caja diaria no se usan el mismo día: si hoy ya se apuntó la Caja diaria, no se abre el TPV. */
export async function cajaDiariaHoy(db, dia = hoyEnTienda()) {
  return (await db.query("SELECT 1 FROM daily_sales WHERE day = $1 AND (amount_cents > 0 OR customers > 0) LIMIT 1", [dia])).rowCount > 0;
}

export async function abrirCaja(pool, { recuento: entrada, usuario }) {
  const { recuento, total } = leerRecuento(entrada);
  return withTransaction(pool, async (client) => {
    if (await sesionAbierta(client)) throw new HttpError(409, 'La caja ya está abierta.', 'CASH_OPEN');
    if (await cajaDiariaHoy(client)) {
      throw new HttpError(409, 'Hoy ya se apuntaron ventas en la Caja diaria: el TPV y la Caja diaria no se usan el mismo día.', 'DAILY_CASH_USED');
    }
    const r = (await client.query(
      'INSERT INTO tpv_cash_sessions (opened_by, opening_counts, opening_cents) VALUES ($1, $2, $3) RETURNING id',
      [usuario.id, JSON.stringify(recuento), total],
    )).rows[0];
    return r.id;
  });
}

export async function movimiento(pool, { tipo, importe, concepto, usuario }) {
  if (!['entrada', 'salida'].includes(tipo)) throw new HttpError(400, 'Movimiento no válido.', 'INVALID_MOVE');
  const cents = Number(importe);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 10_000_000) throw new HttpError(400, 'Importe no válido.', 'INVALID_MOVE');
  const texto = String(concepto ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!texto) throw new HttpError(400, 'Escribe el concepto (por ejemplo «Pago al cartero» o «Cambio del banco»).', 'INVALID_MOVE');
  const s = await sesionAbierta(pool);
  if (!s) throw new HttpError(409, 'La caja está cerrada.', 'CASH_CLOSED');
  await pool.query('INSERT INTO tpv_cash_moves (session_id, kind, amount_cents, concept, created_by) VALUES ($1, $2, $3, $4, $5)', [s.id, tipo, cents, texto, usuario.id]);
}

/** Cuentas de una sesión: efectivo esperado y lo cobrado por cada método. */
export async function resumenSesion(db, id) {
  const s = (await db.query(
    `SELECT s.*, uo.name AS abrio, uc.name AS cerro,
            to_char(s.opened_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS apertura,
            to_char(s.closed_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS cierre
       FROM tpv_cash_sessions s LEFT JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by
      WHERE s.id = $1`, [id, TZ],
  )).rows[0];
  if (!s) throw new HttpError(404, 'Esa caja no existe.', 'SESSION_NOT_FOUND');
  const metodos = (await db.query(
    `SELECT p.method, sum(p.amount_cents)::int AS cents, count(DISTINCT t.id)::int AS tickets
       FROM tpv_tickets t JOIN tpv_ticket_payments p ON p.ticket_id = t.id WHERE t.session_id = $1 GROUP BY p.method`, [id],
  )).rows;
  const tickets = (await db.query('SELECT count(*)::int AS n, COALESCE(sum(total_cents), 0)::int AS total FROM tpv_tickets WHERE session_id = $1', [id])).rows[0];
  const movimientos = (await db.query(
    `SELECT m.id, m.kind, m.amount_cents, m.concept, u.name AS quien, to_char(m.created_at AT TIME ZONE $2, 'HH24:MI') AS hora
       FROM tpv_cash_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.session_id = $1 ORDER BY m.created_at`, [id, TZ],
  )).rows;
  const porMetodo = Object.fromEntries(metodos.map((m) => [m.method, m.cents]));
  const entradas = movimientos.filter((m) => m.kind === 'entrada').reduce((a, m) => a + m.amount_cents, 0);
  const salidas = movimientos.filter((m) => m.kind === 'salida').reduce((a, m) => a + m.amount_cents, 0);
  const efectivo = porMetodo.efectivo ?? 0;
  return {
    id: s.id, estado: s.status, apertura: s.apertura, abrio: s.abrio, cierre: s.cierre, cerro: s.cerro,
    inicial_cent: s.opening_cents, recuento_inicial: s.opening_counts,
    ventas_efectivo_cent: efectivo, entradas_cent: entradas, salidas_cent: salidas,
    esperado_cent: s.opening_cents + efectivo + entradas - salidas,
    por_metodo: porMetodo, tickets: tickets.n, total_ventas_cent: tickets.total,
    movimientos: movimientos.map((m) => ({ id: m.id, tipo: m.kind, importe_cent: m.amount_cents, concepto: m.concept, quien: m.quien, hora: m.hora })),
    contado_cent: s.closing_cents, recuento_final: s.closing_counts, diferencia_cent: s.difference_cents,
  };
}

/**
 * Cierra la caja con el recuento final. Si no cuadra hace falta `aprobacionId`
 * (de un cierre de esta caja con esa misma diferencia), salvo que cierre un Administrador.
 */
export async function cerrarCaja(pool, { recuento: entrada, usuario, aprobacionId = null }) {
  const { recuento, total } = leerRecuento(entrada);
  return withTransaction(pool, async (client) => {
    const s = (await client.query("SELECT * FROM tpv_cash_sessions WHERE status = 'abierta' FOR UPDATE")).rows[0];
    if (!s) throw new HttpError(409, 'La caja ya está cerrada.', 'CASH_CLOSED');
    const r = await resumenSesion(client, s.id);
    const diferencia = total - r.esperado_cent;
    let aprobacion = null;
    if (diferencia !== 0 && usuario.role !== 'admin') {
      const a = (await client.query('SELECT * FROM tpv_discount_requests WHERE id = $1 FOR UPDATE', [Number(aprobacionId) || 0])).rows[0];
      const vale = a && a.kind === 'cierre' && a.session_id === s.id && a.status === 'aprobado' && new Date(a.expires_at) >= new Date()
        && a.total_cents === total && a.subtotal_cents === r.esperado_cent;
      if (!vale) {
        throw new HttpError(403, `La caja no cuadra (${diferencia > 0 ? 'sobran' : 'faltan'} ${(Math.abs(diferencia) / 100).toFixed(2).replace('.', ',')} €): un Administrador tiene que aprobar el cierre.`, 'CASH_MISMATCH');
      }
      aprobacion = a.id;
      await client.query("UPDATE tpv_discount_requests SET status = 'usado' WHERE id = $1", [a.id]);
    }
    await client.query(
      `UPDATE tpv_cash_sessions SET status = 'cerrada', closed_at = NOW(), closed_by = $2, closing_counts = $3, closing_cents = $4,
              expected_cents = $5, difference_cents = $6, approval_id = $7 WHERE id = $1`,
      [s.id, usuario.id, JSON.stringify(recuento), total, r.esperado_cent, diferencia, aprobacion],
    );
    return { id: s.id, diferencia };
  });
}

/** ¿Se usó el TPV ese día (caja abierta o tickets)? Entonces no se apunta la Caja diaria. */
export async function tpvUsadoEnDia(db, dia) {
  const r = await db.query(
    `SELECT 1 FROM tpv_cash_sessions WHERE (opened_at AT TIME ZONE $2)::date = $1::date
        OR (status = 'abierta' AND (NOW() AT TIME ZONE $2)::date = $1::date)
     UNION ALL SELECT 1 FROM tpv_tickets WHERE (sold_at AT TIME ZONE $2)::date = $1::date LIMIT 1`,
    [dia, TZ],
  );
  return r.rowCount > 0;
}
