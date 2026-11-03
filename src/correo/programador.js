// Revisión diaria del correo: a partir de la hora fijada (8:00 en Canarias),
// una vez al día. Se comprueba cada pocos minutos, así que si el servidor
// estaba parado a esa hora, revisa en cuanto arranca.
import { conBuzon } from './buzon.js';
import { revisarCorreo } from './procesar.js';

const COMPROBAR_CADA_MS = 5 * 60 * 1000;
const CANDADO = 727001; // pg_advisory_lock: una sola revisión a la vez aunque haya dos instancias

export const correoConfigurado = (config) => Boolean(config.correo?.user && config.correo?.pass);

/** Hora y fecha actuales en la tienda. */
function ahoraEnTienda(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}

export const abrirBuzonCon = (config, log) => (trabajo) => conBuzon({ user: config.correo.user, pass: config.correo.pass, log }, trabajo);

/** Revisa el correo con el candado puesto; devuelve null si ya había otra revisión en marcha. */
export async function revisarConCandado(pool, opciones) {
  const client = await pool.connect();
  try {
    const libre = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CANDADO])).rows[0].ok;
    if (!libre) return null;
    try {
      return await revisarCorreo(pool, opciones);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [CANDADO]);
    }
  } finally {
    client.release();
  }
}

/**
 * ¿Toca la revisión de hoy? Pasada la hora, si hoy no ha salido bien ninguna
 * automática. Si falló (Gmail caído, clave mal), se reintenta como mucho cada hora.
 */
export async function tocaHoy(pool, horaFijada, now = new Date()) {
  const { fecha, hora } = ahoraEnTienda(now);
  if (hora < horaFijada) return false;
  const r = (await pool.query(
    `SELECT bool_or(error IS NULL) AS bien, max(started_at) AS ultima FROM mail_runs
      WHERE origin = 'auto' AND (started_at AT TIME ZONE 'Atlantic/Canary')::date = $1::date`,
    [fecha],
  )).rows[0];
  if (r.bien) return false;
  return !r.ultima || now - new Date(r.ultima) >= 60 * 60 * 1000;
}

export function iniciarRevisionDiaria({ pool, config, log = console }) {
  if (!correoConfigurado(config)) {
    log.log('[correo] Sin GMAIL_USER / GMAIL_APP_PASSWORD: la revisión diaria del correo está apagada.');
    return null;
  }
  const comprobar = async () => {
    try {
      if (!(await tocaHoy(pool, config.correo.hora))) return;
      const r = await revisarConCandado(pool, {
        abrirBuzon: abrirBuzonCon(config, log), origen: 'auto', inicio: config.businessStart.slice(0, 7), log,
      });
      if (r) log.log(`[correo] Revisión diaria: ${r.proveedores} de proveedores, ${r.gastos} gastos, ${r.revisar} para revisar.`);
    } catch (error) {
      log.error('[correo] La revisión diaria falló:', error.message);
    }
  };
  const timer = setInterval(comprobar, COMPROBAR_CADA_MS);
  timer.unref();
  setTimeout(comprobar, 30_000).unref();
  return timer;
}
