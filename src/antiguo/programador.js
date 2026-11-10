// Sincronización diaria con gestiondegastos: a partir de la hora fijada (8:00
// en Canarias), una vez al día; si falla, se reintenta como mucho cada hora.
// También se lanza a mano desde Admin › Sistema antiguo.
import { antiguoConfigurado, conectarAntiguo } from './cliente.js';
import { sincronizar } from './sincronizar.js';

const COMPROBAR_CADA_MS = 10 * 60 * 1000;
const REINTENTO_MS = 60 * 60 * 1000;
const CANDADO = 727002; // pg_advisory_lock: una sola sincronización a la vez

function ahoraEnTienda(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}

export async function tocaHoy(pool, horaFijada, now = new Date()) {
  const { fecha, hora } = ahoraEnTienda(now);
  if (hora < horaFijada) return false;
  const r = (await pool.query(
    // Bien = terminó sin error y sin registros fallidos (si alguno falló, se reintenta en una hora).
    `SELECT bool_or(error IS NULL AND finished_at IS NOT NULL
                    AND COALESCE(jsonb_array_length(summary->'errores'), 0) = 0) AS bien, max(started_at) AS ultima FROM legacy_runs
      WHERE origin = 'auto' AND (started_at AT TIME ZONE 'Atlantic/Canary')::date = $1::date`,
    [fecha],
  )).rows[0];
  if (r.bien) return false;
  return !r.ultima || now - new Date(r.ultima) >= REINTENTO_MS;
}

/**
 * Conecta, sincroniza y lo apunta en legacy_runs. Devuelve el resumen, o null
 * si ya había otra sincronización en marcha. Si no se puede conectar, lanza el error.
 */
export async function sincronizarConCandado(pool, { config, origen, userId = null, fetchImpl = fetch, log = console }) {
  const client = await pool.connect();
  let roto;
  try {
    const libre = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [CANDADO])).rows[0].ok;
    if (!libre) return null;
    try {
      const runId = (await pool.query(
        'INSERT INTO legacy_runs (origin, user_id) VALUES ($1, $2) RETURNING id', [origen, userId],
      )).rows[0].id;
      try {
        const fuente = await conectarAntiguo(config.antiguo, fetchImpl);
        const res = await sincronizar(pool, fuente, { inicio: config.businessStart, userId, runId, log });
        await pool.query('UPDATE legacy_runs SET finished_at = NOW(), summary = $2 WHERE id = $1', [runId, JSON.stringify(res)]);
        return res;
      } catch (error) {
        await pool.query('UPDATE legacy_runs SET finished_at = NOW(), error = $2 WHERE id = $1', [runId, error.message]);
        throw error;
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [CANDADO]);
      } catch (error) {
        roto = error;
      }
    }
  } finally {
    // Si no se pudo soltar el candado, la conexión se cierra (y con ella el candado).
    client.release(roto);
  }
}

export function iniciarSincronizacionDiaria({ pool, config, log = console }) {
  if (!antiguoConfigurado(config)) {
    log.log('[antiguo] Sin GESTIONGASTOS_USUARIO / GESTIONGASTOS_CLAVE: la sincronización con gestiondegastos está apagada.');
    return null;
  }
  const comprobar = async () => {
    try {
      if (!(await tocaHoy(pool, config.antiguo.hora))) return;
      const r = await sincronizarConCandado(pool, { config, origen: 'auto', log });
      if (r) {
        log.log(`[antiguo] Sincronización diaria: ${r.dias} días, ${r.gastos} gastos, ${r.mensuales} mensuales, `
          + `${r.adjuntos} archivos; ${r.cambios} cambios y ${r.revisar} archivos para revisar.`);
      }
    } catch (error) {
      log.error('[antiguo] La sincronización diaria falló:', error.message);
    }
  };
  const timer = setInterval(comprobar, COMPROBAR_CADA_MS);
  timer.unref();
  setTimeout(comprobar, 60_000).unref();
  return timer;
}
