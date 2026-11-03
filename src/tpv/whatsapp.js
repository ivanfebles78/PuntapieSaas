// Aviso por WhatsApp para aprobar un descuento: con la API de Meta (WhatsApp
// Cloud) si está configurada; si no, un enlace wa.me con el mensaje escrito
// que el TPV abre para enviarlo a mano.

const GRAPH = 'https://graph.facebook.com/v21.0';

export const whatsappAutomatico = (cfg) => Boolean(cfg?.token && cfg?.phoneId && cfg?.aprobadores?.length);

const euros = (cents) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

export function textoAviso({ quien, pct, total, enlace }) {
  return `${quien} pide un descuento del ${String(pct).replace('.', ',')} % en una venta de ${euros(total)} en Puntapié. Aprobar o rechazar: ${enlace}`;
}

/** Enlace para abrir WhatsApp con el aviso ya escrito (al primer aprobador, si hay). */
export function enlaceManual(cfg, datos) {
  const para = cfg?.aprobadores?.[0] ?? '';
  return `https://wa.me/${para}?text=${encodeURIComponent(textoAviso(datos))}`;
}

/**
 * Envía la plantilla a cada aprobador. Devuelve cuántos mensajes salieron.
 * `enviar` = fetch (inyectable en los tests).
 */
export async function enviarAviso(cfg, datos, { enviar = fetch, log = console } = {}) {
  let enviados = 0;
  for (const to of cfg.aprobadores) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: cfg.plantilla,
        language: { code: cfg.idioma },
        components: [{
          type: 'body',
          parameters: [datos.quien, `${String(datos.pct).replace('.', ',')} %`, euros(datos.total), datos.enlace].map((text) => ({ type: 'text', text })),
        }],
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
