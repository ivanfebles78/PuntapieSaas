// Cliente de la API de la app antigua (gestiondegastos, PHP en Bluehost).
// Entra con usuario y contraseña (token Bearer) y solo LEE: ventas por día,
// gastos diarios, gastos mensuales y los archivos pegados a cada día.

const TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const antiguoConfigurado = (config) => Boolean(config.antiguo?.url && config.antiguo?.usuario && config.antiguo?.clave);

export class ErrorAntiguo extends Error {}

async function pedir(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new ErrorAntiguo(`No se pudo conectar con gestiondegastos (${error.name === 'TimeoutError' ? 'no responde' : error.message}).`);
  }
  return res;
}

async function leerJson(res, que) {
  if (!res.ok) throw new ErrorAntiguo(`gestiondegastos respondió ${res.status} al pedir ${que}.`);
  try {
    return await res.json();
  } catch {
    throw new ErrorAntiguo(`gestiondegastos no devolvió datos válidos al pedir ${que}.`);
  }
}

/**
 * Entra en la API antigua y devuelve la «fuente» que usa la sincronización:
 * { ventas(), gastosDiarios(), gastosMensuales(), adjuntos(), archivo(id) }.
 */
export async function conectarAntiguo({ url, usuario, clave }, fetchImpl = fetch) {
  const login = await pedir(fetchImpl, `${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: usuario, password: clave }),
  });
  if (login.status === 401) throw new ErrorAntiguo('gestiondegastos no acepta el usuario o la contraseña (revisa GESTIONGASTOS_USUARIO y GESTIONGASTOS_CLAVE en Railway).');
  const { access_token: token } = await leerJson(login, 'la entrada');
  if (!token) throw new ErrorAntiguo('gestiondegastos no devolvió la sesión.');
  const auth = { Authorization: `Bearer ${token}` };

  const lista = async (ruta, que) => {
    const data = await leerJson(await pedir(fetchImpl, `${url}${ruta}`, { headers: auth }), que);
    if (!Array.isArray(data)) throw new ErrorAntiguo(`gestiondegastos no devolvió una lista al pedir ${que}.`);
    return data;
  };

  return {
    ventas: () => lista('/api/daily-sales', 'las ventas'),
    gastosDiarios: () => lista('/api/daily-expenses', 'los gastos diarios'),
    gastosMensuales: () => lista('/api/monthly-expenses', 'los gastos mensuales'),
    adjuntos: () => lista('/api/daily-attachments', 'los archivos'),
    /** Descarga un archivo; null si ya no está en el servidor antiguo. */
    async archivo(id) {
      const res = await pedir(fetchImpl, `${url}/api/daily-attachments/${Number(id)}/file`, { headers: auth });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new ErrorAntiguo(`gestiondegastos respondió ${res.status} al descargar un archivo.`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_FILE_BYTES) throw new ErrorAntiguo('El archivo del sistema antiguo es demasiado grande.');
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_FILE_BYTES) throw new ErrorAntiguo('El archivo del sistema antiguo es demasiado grande.');
      return { data, mime: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
    },
  };
}
