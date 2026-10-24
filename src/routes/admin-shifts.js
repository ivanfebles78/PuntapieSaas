import { listAudit } from '../services/audit.js';
import {
  addFreeShift,
  createOpening,
  deleteFreeShift,
  deleteOpening,
  getBonusOverview,
  listOpenings,
  readFreeShift,
  readNote,
  readOpening,
  readStaff,
  updateOpening,
} from '../services/extra-shifts.js';
import { describeSlots, getSchedule, readSlots, setSchedule } from '../services/schedules.js';
import { shiftLabel, shopHours } from '../services/shop-hours.js';
import { TeamError, getMember } from '../services/team.js';
import { todayInShop } from '../services/vacation-balance.js';

const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** «2026-08-03» → «03/08/2026». */
export const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : null);

function readPositiveId(value, message, code) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TeamError(404, message, code);
  return id;
}

const openingLabel = (o) => `${esDate(o.day)} · ${shiftLabel(o.shift)}`;
const staffNames = (staff) => (staff.length ? staff.map((p) => p.name).join(', ') : 'Nadie');

/**
 * Turnos, horas bonificadas, aperturas extra y log de acciones. Se montan en
 * el router de Admin (ya protegido por rol).
 */
export function registerShiftRoutes(router, { pool, audit, readUserId }) {
  router.get('/horario', (_req, res) => {
    res.json({ ok: true, data: shopHours() });
  });

  /* ---------- Turno fijo de cada persona ---------- */

  router.get('/users/:id/turno', handle(async (req, res) => {
    res.json({ ok: true, data: await getSchedule(pool, readUserId(req.params.id), todayInShop()) });
  }));

  router.put('/users/:id/turno', handle(async (req, res) => {
    const userId = readUserId(req.params.id);
    const member = await getMember(pool, userId);
    const saved = await setSchedule(pool, {
      userId,
      slots: readSlots(req.body?.slots),
      validFrom: req.body?.validFrom ?? todayInShop(),
      updatedBy: req.user.id,
    });
    await audit(req, {
      area: 'turnos',
      action: 'editar',
      target: member.name,
      changes: [{ field: `Turno desde el ${esDate(saved.validFrom)}`, from: saved.previous ? describeSlots(saved.previous.slots) : 'Sin turno', to: describeSlots(saved.slots) }],
    });
    res.json({ ok: true, data: await getSchedule(pool, userId, todayInShop()) });
  }));

  /* ---------- Horas bonificadas y turnos libres ---------- */

  router.get('/users/:id/horas', handle(async (req, res) => {
    res.json({ ok: true, data: await getBonusOverview(pool, readUserId(req.params.id)) });
  }));

  router.post('/users/:id/horas', handle(async (req, res) => {
    const userId = readUserId(req.params.id);
    const member = await getMember(pool, userId);
    const freeShift = await addFreeShift(pool, { userId, ...readFreeShift(req.body), createdBy: req.user.id });
    await audit(req, {
      area: 'horas',
      action: 'crear',
      target: member.name,
      changes: [{ field: 'Turno libre (−3,5 h)', from: null, to: `${esDate(freeShift.day)} · ${shiftLabel(freeShift.shift)}${freeShift.note ? ` · ${freeShift.note}` : ''}` }],
    });
    res.status(201).json({ ok: true, data: await getBonusOverview(pool, userId) });
  }));

  router.delete('/users/:id/horas/:freeShiftId', handle(async (req, res) => {
    const userId = readUserId(req.params.id);
    const member = await getMember(pool, userId);
    const removed = await deleteFreeShift(pool, userId, readPositiveId(req.params.freeShiftId, 'Ese turno libre no existe.', 'FREE_SHIFT_NOT_FOUND'));
    await audit(req, {
      area: 'horas',
      action: 'borrar',
      target: member.name,
      changes: [{ field: 'Turno libre (+3,5 h)', from: `${esDate(removed.day)} · ${shiftLabel(removed.shift)}`, to: null }],
    });
    res.json({ ok: true, data: await getBonusOverview(pool, userId) });
  }));

  /* ---------- Aperturas extra ---------- */

  router.get('/aperturas', handle(async (_req, res) => {
    res.json({ ok: true, data: await listOpenings(pool) });
  }));

  router.post('/aperturas', handle(async (req, res) => {
    const opening = await createOpening(pool, { ...readOpening(req.body), createdBy: req.user.id });
    await audit(req, {
      area: 'aperturas',
      action: 'crear',
      target: openingLabel(opening),
      changes: [
        { field: 'Equipo', from: null, to: staffNames(opening.staff) },
        ...(opening.note ? [{ field: 'Nota', from: null, to: opening.note }] : []),
      ],
    });
    res.status(201).json({ ok: true, data: opening });
  }));

  router.patch('/aperturas/:id', handle(async (req, res) => {
    const id = readPositiveId(req.params.id, 'Esa apertura no existe.', 'OPENING_NOT_FOUND');
    const changes = {};
    if (req.body?.staff !== undefined) changes.staff = readStaff(req.body.staff);
    if (req.body?.note !== undefined) changes.note = readNote(req.body.note);
    const { before, after } = await updateOpening(pool, id, changes);
    const diff = [];
    if (staffNames(before.staff) !== staffNames(after.staff)) diff.push({ field: 'Equipo', from: staffNames(before.staff), to: staffNames(after.staff) });
    if (before.note !== after.note) diff.push({ field: 'Nota', from: before.note || null, to: after.note || null });
    if (diff.length) await audit(req, { area: 'aperturas', action: 'editar', target: openingLabel(after), changes: diff });
    res.json({ ok: true, data: after });
  }));

  router.delete('/aperturas/:id', handle(async (req, res) => {
    const removed = await deleteOpening(pool, readPositiveId(req.params.id, 'Esa apertura no existe.', 'OPENING_NOT_FOUND'));
    await audit(req, {
      area: 'aperturas',
      action: 'borrar',
      target: openingLabel(removed),
      changes: [{ field: 'Equipo', from: staffNames(removed.staff), to: null }],
    });
    res.json({ ok: true });
  }));

  /* ---------- Log de acciones ---------- */

  // ?usuario&area&accion&desde&hasta&q&pagina&limite
  router.get('/log', handle(async (req, res) => {
    res.json({ ok: true, data: await listAudit(pool, req.query) });
  }));
}
