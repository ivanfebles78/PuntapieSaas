const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function layout({ greeting, paragraphs, cta, link, footnote }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1b1a17">
      <h2 style="margin:0 0 16px">Puntapié · calzado infantil</h2>
      <p>${escapeHtml(greeting)}</p>
      ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
      <p style="margin:28px 0">
        <a href="${escapeHtml(link)}" style="background:#1b1a17;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none">${escapeHtml(cta)}</a>
      </p>
      <p style="font-size:13px;color:#6b645a">${escapeHtml(footnote)}</p>
    </div>`;
  const text = [greeting, '', ...paragraphs, '', `${cta}: ${link}`, '', footnote].join('\n');
  return { html, text };
}

function resetEmail({ name, link, minutes }) {
  return {
    subject: 'Restablecer tu contraseña · Puntapié',
    ...layout({
      greeting: `Hola ${name}:`,
      paragraphs: ['Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de Puntapié.'],
      cta: 'Elegir nueva contraseña',
      link,
      footnote: `El enlace caduca en ${minutes} minutos y solo puede usarse una vez. Si no lo has pedido tú, ignora este correo.`,
    }),
  };
}

function inviteEmail({ name, link, days, invitedBy }) {
  return {
    subject: 'Te han invitado a la gestión de Puntapié',
    ...layout({
      greeting: `Hola ${name}:`,
      paragraphs: [
        `${invitedBy} te ha dado acceso a la aplicación de gestión de Puntapié.`,
        'Solo tienes que crear tu contraseña para entrar.',
      ],
      cta: 'Crear mi contraseña',
      link,
      footnote: `La invitación caduca en ${days} días y solo puede usarse una vez.`,
    }),
  };
}

/**
 * Envía con Resend si hay clave; si no, deja el enlace en los logs para
 * poder probar en local sin servicio de correo. Devuelve true solo si el
 * correo ha salido de verdad.
 */
export function createMailer(cfg, log = console) {
  async function send(to, message, link) {
    if (!cfg.resendApiKey) {
      log.warn(`[mail] RESEND_API_KEY no configurada. «${message.subject}» para ${to}: ${link}`);
      return false;
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
    return true;
  }

  return {
    sendPasswordReset({ to, name, link }) {
      const minutes = Math.round(cfg.resetTokenTtlMs / 60000);
      return send(to, resetEmail({ name, link, minutes }), link);
    },
    sendInvitation({ to, name, link, invitedBy }) {
      const days = Math.round(cfg.inviteTokenTtlMs / 86400000);
      return send(to, inviteEmail({ name, link, days, invitedBy }), link);
    },
  };
}
