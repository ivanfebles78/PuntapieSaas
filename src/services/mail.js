const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function resetEmail({ name, link, minutes }) {
  const subject = 'Restablecer tu contraseña · Puntapié';
  const text = [
    `Hola ${name}:`,
    '',
    'Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de Puntapié.',
    `Abre este enlace (válido durante ${minutes} minutos y un solo uso):`,
    link,
    '',
    'Si no lo has pedido tú, ignora este correo: tu contraseña no cambiará.',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1b1a17">
      <h2 style="margin:0 0 16px">Puntapié · calzado infantil</h2>
      <p>Hola ${escapeHtml(name)}:</p>
      <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta.</p>
      <p style="margin:28px 0">
        <a href="${escapeHtml(link)}" style="background:#1b1a17;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">Elegir nueva contraseña</a>
      </p>
      <p style="font-size:13px;color:#6b645a">El enlace caduca en ${minutes} minutos y solo puede usarse una vez.
      Si no lo has pedido tú, ignora este correo.</p>
    </div>`;
  return { subject, text, html };
}

/**
 * Envía con Resend si hay clave; si no, deja el enlace en los logs para
 * poder probar en local sin servicio de correo.
 */
export function createMailer(cfg, log = console) {
  return {
    async sendPasswordReset({ to, name, link }) {
      const minutes = Math.round(cfg.resetTokenTtlMs / 60000);
      const message = resetEmail({ name, link, minutes });
      if (!cfg.resendApiKey) {
        log.warn(`[mail] RESEND_API_KEY no configurada. Enlace para ${to}: ${link}`);
        return;
      }
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: cfg.mailFrom, to: [to], ...message }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Resend respondió ${response.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}
