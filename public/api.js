const NETWORK_ERROR = 'No hay conexión con el servidor. Inténtalo de nuevo.';

/** Llama a la API y devuelve siempre { ok, status, data?, error?, code? }. */
export async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  const json = await response.json().catch(() => ({ ok: false, error: NETWORK_ERROR }));
  return { status: response.status, ...json };
}
