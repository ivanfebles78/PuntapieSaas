// Aviso por WhatsApp para que un Administrador apruebe algo desde el móvil (un
// descuento de más del 15 % o un cierre de caja que no cuadra). Con la API de
// Meta (WhatsApp Cloud) si está configurada: una sola plantilla con dos
// variables, {{1}} = qué se pide y {{2}} = el enlace. Si no, un enlace wa.me
// con el mensaje escrito que el TPV abre para enviarlo a mano.

const GRAPH = 'https://graph.facebook.com/v21.0';

export const whatsappAutomatico = (cfg) => Boolean(cfg?.token && cfg?.phoneId && cfg?.aprobadores?.length);

export const euros = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;
const pct = (n) => `${String(n).replace('.', ',')} %`;

/** Qué se pide, en una frase (sin el enlace). */
export function textoSolicitud(s) {
  if (s.tipo === 'cierre') {
    const d = s.contado - s.esperado;
    return `${s.quien} quiere cerrar la caja de Puntapié con un descuadre: ${d > 0 ? 'sobran' : 'faltan'} ${euros(Math.abs(d))} (esperado ${euros(s.esperado)}, contado ${euros(s.contado)})`;
  }
  return `${s.quien} pide un descuento del ${pct(s.pct)} en una venta de ${euros(s.total)} en Puntapié`;
}

export const textoAviso = ({ texto, enlace }) => `${texto}. Aprobar o rechazar: ${enlace}`;

/** Enlace para abrir WhatsApp con el aviso ya escrito (al primer aprobador, si hay). */
export function enlaceManual(cfg, datos) {
  const para = cfg?.aprobadores?.[0] ?? '';
  return `https://wa.me/${para}?text=${encodeURIComponent(textoAviso(datos))}`;
}

/**
 * Envía la plantilla a cada aprobador. Devuelve cuántos mensajes salieron.
 * `enviar` = fetch (inyectable en los tests).
 */
export async function enviarAviso(cfg, { texto, enlace }, { enviar = fetch, log = console } = {}) {
  let enviados = 0;
  for (const to of cfg.aprobadores) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: cfg.plantilla,
        language: { code: cfg.idioma },
        components: [{ type: 'body', parameters: [texto, enlace].map((text) => ({ type: 'text', text })) }],
      },
    };
    try {
      const res = await enviar(`${GRAPH}/${cfg.phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) enviados += 1;
      else log.error('[whatsapp] Meta rechazó el aviso:', res.status, (await res.text()).slice(0, 300));
    } catch (error) {
      log.error('[whatsapp] No se pudo enviar el aviso:', error.message);
    }
  }
  return enviados;
}
