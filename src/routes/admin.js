import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { httpErrorHandler } from '../http-error.js';
import { ROLES, ROLE_IDS, isValidRole } from '../roles.js';
import { auditFrom, diffFields } from '../services/audit.js';
import { esDate, registerShiftRoutes } from './admin-shifts.js';
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
import {
  addVacation,
  deleteVacation,
  getVacationOverview,
  readVacation,
  setContractStart,
} from '../services/vacations.js';

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

const vacationText = (v) => `${esDate(v.start)} → ${esDate(v.end)} (${v.days} ${v.days === 1 ? 'día' : 'días'})${v.note ? ` · ${v.note}` : ''}`;

export function adminRouter({ pool, config: cfg, mailer, log = console }) {
  const router = Router();
  // El Asesor también entra, pero solo a leer (las escrituras las corta forbidReadOnlyWrites).
  router.use(requireRole('admin', 'asesor'));
  const audit = auditFrom(pool, log);
  const roleName = (id) => ROLES[id]?.label ?? id;
  const memberFields = (m) => ({ name: m.name, role: roleName(m.role), email: m.email, seller: m.isSeller ? 'Sí' : 'No (solo gestiona)' });
  const MEMBER_LABELS = { name: 'Nombre', email: 'Correo', role: 'Rol', seller: 'Vende en tienda' };

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
      await audit(req, {
        area: 'usuarios',
        action: 'crear',
        target: member.name,
        changes: diffFields({}, memberFields(member), { name: 'Nombre', email: 'Correo', role: 'Rol' }),
      });
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
      if (req.body?.isSeller !== undefined) {
        if (typeof req.body.isSeller !== 'boolean') throw new TeamError(400, 'Indica si vende en tienda (sí o no).', 'INVALID_SELLER');
        changes.isSeller = req.body.isSeller;
      }
      if (Object.keys(changes).length === 0) {
        throw new TeamError(400, 'No hay cambios que guardar.', 'NO_CHANGES');
      }
      const id = readId(req.params.id);
      const before = await getMember(pool, id);
      const member = await updateMember(pool, req.user.id, id, changes);
      await audit(req, {
        area: 'usuarios',
        action: 'editar',
        target: member.name,
        changes: diffFields(memberFields(before), memberFields(member), MEMBER_LABELS),
      });
      res.json({ ok: true, data: member });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/deactivate', async (req, res, next) => {
    try {
      const member = await deactivateMember(pool, req.user.id, readId(req.params.id));
      await audit(req, { area: 'usuarios', action: 'baja', target: member.name, changes: [{ field: 'Estado', from: 'Activo', to: 'De baja' }] });
      res.json({ ok: true, data: member });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/reactivate', async (req, res, next) => {
    try {
      const member = await reactivateMember(pool, readId(req.params.id));
      await audit(req, { area: 'usuarios', action: 'reactivar', target: member.name, changes: [{ field: 'Estado', from: 'De baja', to: 'Activo' }] });
      res.json({ ok: true, data: member });
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
      const delivery = await sendAccessLink(member, req.user);
      await audit(req, {
        area: 'usuarios',
        action: 'enviar_acceso',
        target: member.name,
        changes: [{ field: delivery.kind === 'invite' ? 'Invitación' : 'Enlace de contraseña', from: null, to: delivery.mailSent ? `Enviado a ${member.email}` : `No salió el correo a ${member.email}` }],
      });
      res.json({ ok: true, data: { user: member, ...delivery } });
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
      // La contraseña nunca va al log: solo que se generó.
      await audit(req, { area: 'usuarios', action: 'contrasena_provisional', target: user.name });
      res.json({ ok: true, data: { user, temporaryPassword } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/users/:id/vacations', async (req, res, next) => {
    try {
      res.json({ ok: true, data: await getVacationOverview(pool, readId(req.params.id)) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/users/:id/contract-start', async (req, res, next) => {
    try {
      const id = readId(req.params.id);
      const before = await getVacationOverview(pool, id);
      const member = await getMember(pool, id);
      const contractStart = await setContractStart(pool, id, req.body?.contractStart ?? null);
      if (contractStart !== before.contractStart) {
        await audit(req, {
          area: 'vacaciones',
          action: 'editar',
          target: member.name,
          changes: [{ field: 'Inicio de contrato', from: esDate(before.contractStart), to: esDate(contractStart) }],
        });
      }
      res.json({ ok: true, data: await getVacationOverview(pool, id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/vacations', async (req, res, next) => {
    try {
      const period = readVacation(req.body);
      const userId = readId(req.params.id);
      const vacation = await addVacation(pool, { userId, ...period, createdBy: req.user.id });
      await audit(req, {
        area: 'vacaciones',
        action: 'crear',
        target: (await getMember(pool, userId)).name,
        changes: [{ field: 'Periodo', from: null, to: vacationText(vacation) }],
      });
      res.status(201).json({ ok: true, data: vacation });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/users/:id/vacations/:vacationId', async (req, res, next) => {
    try {
      const vacationId = Number(req.params.vacationId);
      if (!Number.isInteger(vacationId) || vacationId <= 0) {
        throw new TeamError(404, 'Ese periodo de vacaciones no existe.', 'VACATION_NOT_FOUND');
      }
      const userId = readId(req.params.id);
      const removed = await deleteVacation(pool, userId, vacationId);
      await audit(req, {
        area: 'vacaciones',
        action: 'borrar',
        target: (await getMember(pool, userId)).name,
        changes: [{ field: 'Periodo', from: vacationText(removed), to: null }],
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  registerShiftRoutes(router, { pool, audit, readUserId: readId });

  router.use(httpErrorHandler);
  router.use((error, _req, res, next) => {
    if (!(error instanceof TeamError)) return next(error);
    return res.status(error.status).json({ ok: false, error: error.message, code: error.code });
  });

  return router;
}
