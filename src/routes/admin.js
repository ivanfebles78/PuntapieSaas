import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { ROLES, ROLE_IDS, isValidRole } from '../roles.js';
import {
  TeamError,
  createInvitedMember,
  deactivateMember,
  getMember,
  listMembers,
  reactivateMember,
  setTemporaryPassword,
  updateMember,
} from '../services/team.js';
import { createPasswordReset } from '../services/users.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
// Sin caracteres que se confunden al dictarlos (0/O, 1/l/I).
const TEMP_LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const TEMP_DIGITS = '23456789';
const TEMP_LETTER_COUNT = 6;
const TEMP_DIGIT_COUNT = 4;

function pick(alphabet, count) {
  return Array.from({ length: count }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/** Ej.: «kmtwpa-4827»: fácil de dictar y cumple letras + números. */
function generateTemporaryPassword() {
  return `${pick(TEMP_LETTERS, TEMP_LETTER_COUNT)}-${pick(TEMP_DIGITS, TEMP_DIGIT_COUNT)}`;
}

function readName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new TeamError(400, 'Escribe el nombre.', 'INVALID_NAME');
  if (name.length > MAX_NAME_LENGTH) {
    throw new TeamError(400, `El nombre no puede superar ${MAX_NAME_LENGTH} caracteres.`, 'INVALID_NAME');
  }
  return name;
}

function readEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
    throw new TeamError(400, 'Escribe un correo electrónico válido.', 'INVALID_EMAIL');
  }
  return email;
}

function readRole(value) {
  if (!isValidRole(value)) throw new TeamError(400, 'Elige un rol válido.', 'INVALID_ROLE');
  return value;
}

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TeamError(404, 'No existe ese usuario.', 'USER_NOT_FOUND');
  return id;
}

export function adminRouter({ pool, config: cfg, mailer, log = console }) {
  const router = Router();
  router.use(requireRole('admin'));

  /**
   * Envía la invitación (si aún no tiene contraseña) o un enlace para
   * restablecerla. Si el correo falla, la acción no se deshace: se avisa.
   */
  async function sendAccessLink(member, actor) {
    const isInvite = member.status === 'invitado';
    const purpose = isInvite ? 'invite' : 'reset';
    const ttl = isInvite ? cfg.inviteTokenTtlMs : cfg.resetTokenTtlMs;
    const token = await createPasswordReset(pool, member.id, ttl, purpose);
    const link = `${cfg.appUrl}/restablecer?token=${encodeURIComponent(token)}`;
    try {
      const delivered = isInvite
        ? await mailer.sendInvitation({ to: member.email, name: member.name, link, invitedBy: actor.name })
        : await mailer.sendPasswordReset({ to: member.email, name: member.name, link });
      return { mailSent: delivered !== false, kind: purpose };
    } catch (error) {
      log.error(`[admin] No se pudo enviar el correo a ${member.email}:`, error.message);
      return { mailSent: false, kind: purpose };
    }
  }

  router.get('/roles', (_req, res) => {
    res.json({ ok: true, data: ROLE_IDS.map((id) => ({ id, ...ROLES[id] })) });
  });

  router.get('/users', async (_req, res, next) => {
    try {
      res.json({ ok: true, data: await listMembers(pool) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users', async (req, res, next) => {
    try {
      const member = await createInvitedMember(pool, {
        email: readEmail(req.body?.email),
        name: readName(req.body?.name),
        role: readRole(req.body?.role),
        invitedBy: req.user.id,
      });
      const delivery = await sendAccessLink(member, req.user);
      res.status(201).json({ ok: true, data: { user: member, ...delivery } });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/users/:id', async (req, res, next) => {
    try {
      const changes = {};
      if (req.body?.name !== undefined) changes.name = readName(req.body.name);
      if (req.body?.role !== undefined) changes.role = readRole(req.body.role);
      if (req.body?.email !== undefined) changes.email = readEmail(req.body.email);
      if (Object.keys(changes).length === 0) {
        throw new TeamError(400, 'No hay cambios que guardar.', 'NO_CHANGES');
      }
      const member = await updateMember(pool, req.user.id, readId(req.params.id), changes);
      res.json({ ok: true, data: member });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/deactivate', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await deactivateMember(pool, req.user.id, readId(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/reactivate', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await reactivateMember(pool, readId(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  // Reenvía la invitación a quien aún no tiene contraseña; al resto, enlace de restablecer.
  router.post('/users/:id/send-access', async (req, res, next) => {
    try {
      const member = await getMember(pool, readId(req.params.id));
      if (member.status === 'baja') {
        throw new TeamError(409, 'Reactiva la cuenta antes de enviarle un enlace.', 'USER_INACTIVE');
      }
      if (!member.email) {
        throw new TeamError(409, 'Esta cuenta no tiene correo. Añádelo o usa una contraseña provisional.', 'NO_EMAIL');
      }
      res.json({ ok: true, data: { user: member, ...(await sendAccessLink(member, req.user)) } });
    } catch (error) {
      next(error);
    }
  });

  // Para cuentas sin correo: contraseña provisional que se muestra una sola vez
  // al Administrador y que la persona debe cambiar al entrar.
  router.post('/users/:id/temporary-password', async (req, res, next) => {
    try {
      const id = readId(req.params.id);
      if (id === req.user.id) {
        throw new TeamError(409, 'Para tu propia cuenta, cambia la contraseña desde tu perfil.', 'SELF_PASSWORD');
      }
      const temporaryPassword = generateTemporaryPassword();
      const user = await setTemporaryPassword(pool, id, await hashPassword(temporaryPassword));
      res.json({ ok: true, data: { user, temporaryPassword } });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _req, res, next) => {
    if (!(error instanceof TeamError)) return next(error);
    return res.status(error.status).json({ ok: false, error: error.message, code: error.code });
  });

  return router;
}
