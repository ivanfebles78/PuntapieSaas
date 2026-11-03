// Vales de compra: se emiten en un cambio por lo que el cliente no se lleva.
// Tienen un código (el del QR), importe, saldo y caducidad (TPV_VALE_MESES); se gastan
// en una o varias compras hasta agotar el saldo. No se cambian por dinero.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError } from '../http-error.js';

const TZ = 'Atlantic/Canary';
// Sin letras ni cifras que se confundan (O/0, I/1…) y sin guiones: la pistola
// los teclea igual con cualquier distribución de teclado.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO = 8;

/** «V26K7M3Q9XT»: V + año + 8 caracteres al azar. */
export function nuevoCodigoVale(year) {
  const azar = Array.from(crypto.randomBytes(LARGO), (b) => ALFABETO[b % ALFABETO.length]).join('');
  return `V${String(year).slice(2)}${azar}`;
}

/** Normaliza lo escaneado o tecleado («v26-k7m3-q9xt» → «V26K7M3Q9XT»), o null si no parece un vale. */
export function leerCodigoVale(texto) {
  const c = String(texto ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^V\d{2}[A-Z0-9]{8}$/.test(c) ? c : null;
}

export const formatoCodigo = (c) => `${c.slice(0, 3)}-${c.slice(3, 7)}-${c.slice(7)}`;

/** Emite un vale por `importe` dentro de la transacción del cambio. */
export async function emitirVale(client, { importe, ticketId, usuario, meses }) {
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));
  for (let i = 0; i < 5; i += 1) {
    const code = nuevoCodigoVale(year);
    const r = await client.query(
      `INSERT INTO tpv_vouchers (code, expires_on, amount_cents, balance_cents, origin_ticket_id, issued_by)
       VALUES ($1, ((NOW() AT TIME ZONE $5)::date + make_interval(months => $6))::date, $2, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING RETURNING id`,
      [code, importe, ticketId, usuario.id, TZ, meses],
    );
    if (r.rowCount) return { id: r.rows[0].id, codigo: code };
  }
  throw new HttpError(500, 'No se pudo generar el código del vale.', 'VOUCHER_CODE');
}

/** El vale con su estado y sus usos (para la pantalla, el QR y el ticket del vale). */
export async function obtenerVale(db, codigo, { conQr = false } = {}) {
  const code = leerCodigoVale(codigo);
  if (!code) throw new HttpError(404, 'Ese código no es de un vale.', 'VOUCHER_NOT_FOUND');
  const v = (await db.query(
    `SELECT v.*, to_char(v.issued_at AT TIME ZONE $2, 'DD/MM/YYYY') AS emitido, to_char(v.expires_on, 'DD/MM/YYYY') AS caduca,
            (v.expires_on < (NOW() AT TIME ZONE $2)::date) AS caducado, t.number AS ticket,
            (EXTRACT(year FROM age(v.expires_on, (v.issued_at AT TIME ZONE $2)::date)) * 12
              + EXTRACT(month FROM age(v.expires_on, (v.issued_at AT TIME ZONE $2)::date)))::int AS meses
       FROM tpv_vouchers v LEFT JOIN tpv_tickets t ON t.id = v.origin_ticket_id WHERE v.code = $1`, [code, TZ],
  )).rows[0];
  if (!v) throw new HttpError(404, `El vale ${formatoCodigo(code)} no existe.`, 'VOUCHER_NOT_FOUND');
  const usos = (await db.query(
    `SELECT u.amount_cents, to_char(u.created_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS fecha, t.number AS ticket
       FROM tpv_voucher_uses u JOIN tpv_tickets t ON t.id = u.ticket_id WHERE u.voucher_id = $1 ORDER BY u.created_at`, [v.id, TZ],
  )).rows;
  const estado = v.caducado ? 'caducado' : v.balance_cents === 0 ? 'agotado' : 'activo';
  return {
    id: v.id, codigo: v.code, codigo_legible: formatoCodigo(v.code), emitido: v.emitido, caduca: v.caduca, validez_meses: v.meses, estado,
    importe_cent: v.amount_cents, saldo_cent: v.balance_cents, ticket_origen: v.ticket,
    usos: usos.map((u) => ({ importe_cent: u.amount_cents, fecha: u.fecha, ticket: u.ticket })),
    ...(conQr ? { qr_svg: await QRCode.toString(v.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) } : {}),
  };
}

/**
 * Cobra con vales los pagos que lo indican: comprueba que el vale existe, no
 * ha caducado y tiene saldo, y lo descuenta. Devuelve los pagos con su vale.
 */
export async function cobrarConVales(client, pagos, ticketId) {
  const resultado = [];
  for (const p of pagos) {
    if (p.metodo !== 'vales') {
      resultado.push(p);
      continue;
    }
    const code = leerCodigoVale(p.vale);
    if (!code) throw new HttpError(400, 'Para cobrar con un vale, escanea su código QR.', 'VOUCHER_REQUIRED');
    const v = (await client.query(
      `SELECT id, balance_cents, (expires_on < (NOW() AT TIME ZONE $2)::date) AS caducado FROM tpv_vouchers WHERE code = $1 FOR UPDATE`,
      [code, TZ],
    )).rows[0];
    if (!v) throw new HttpError(404, `El vale ${formatoCodigo(code)} no existe.`, 'VOUCHER_NOT_FOUND');
    if (v.caducado) throw new HttpError(409, `El vale ${formatoCodigo(code)} ha caducado.`, 'VOUCHER_EXPIRED');
    if (v.balance_cents < p.importe) {
      throw new HttpError(409, `El vale ${formatoCodigo(code)} solo tiene ${(v.balance_cents / 100).toFixed(2).replace('.', ',')} € de saldo.`, 'VOUCHER_BALANCE');
    }
    await client.query('UPDATE tpv_vouchers SET balance_cents = balance_cents - $2 WHERE id = $1', [v.id, p.importe]);
    await client.query('INSERT INTO tpv_voucher_uses (voucher_id, ticket_id, amount_cents) VALUES ($1, $2, $3)', [v.id, ticketId, p.importe]);
    resultado.push({ ...p, voucherId: v.id });
  }
  return resultado;
}
