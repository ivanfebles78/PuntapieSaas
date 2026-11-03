// Acceso al buzón de Gmail por IMAP con una contraseña de aplicación
// (GMAIL_USER + GMAIL_APP_PASSWORD). Solo lee los no leídos recientes, sin
// marcarlos (BODY.PEEK); se marcan como leídos aparte, cuando toca.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const HOST = 'imap.gmail.com';
const PUERTO = 993;
const MAX_MENSAJES = 200;

const esPdf = (nodo) => /application\/pdf/i.test(nodo.type ?? '') || /\.pdf$/i.test(nodo.dispositionParameters?.filename ?? nodo.parameters?.name ?? '');
const conPdf = (nodo) => Boolean(nodo) && (esPdf(nodo) || (nodo.childNodes ?? []).some(conPdf));

/** Abre el buzón; `trabajo(buzon)` recibe { noLeidos, marcarLeido } y se cierra al acabar. */
export async function conBuzon({ user, pass, log = console }, trabajo) {
  const client = new ImapFlow({ host: HOST, port: PUERTO, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await trabajo({
      /**
       * Correos no leídos desde `desde` (Date) que no estén en `vistos` (Set de
       * Message-ID). Solo se descargan los que traen algún PDF.
       */
      async noLeidos({ desde, vistos }) {
        const uids = ((await client.search({ seen: false, since: desde }, { uid: true })) || []).slice(-MAX_MENSAJES);
        if (!uids.length) return [];
        const candidatos = [];
        for await (const m of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
          const id = m.envelope?.messageId ?? `uid-${m.uid}`;
          if (!vistos.has(id)) candidatos.push({ uid: m.uid, messageId: id, conPdf: conPdf(m.bodyStructure), envelope: m.envelope });
        }
        const mensajes = [];
        for (const c of candidatos) {
          const from = c.envelope?.from?.[0]?.address ?? '';
          const base = { uid: c.uid, messageId: c.messageId, from, subject: c.envelope?.subject ?? '', date: c.envelope?.date ?? null };
          if (!c.conPdf) {
            mensajes.push({ ...base, adjuntos: [] });
            continue;
          }
          const descarga = await client.download(String(c.uid), undefined, { uid: true });
          if (!descarga?.content) {
            mensajes.push({ ...base, adjuntos: [] });
            continue;
          }
          const parsed = await simpleParser(descarga.content);
          const adjuntos = (parsed.attachments ?? [])
            .filter((a) => /application\/pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename ?? ''))
            .map((a) => ({ filename: a.filename || 'documento.pdf', data: a.content }));
          mensajes.push({ ...base, adjuntos });
        }
        return mensajes;
      },
      async marcarLeido(uid) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      },
    });
  } catch (error) {
    log.error('[correo] Error leyendo el buzón:', error.message);
    throw error;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}
