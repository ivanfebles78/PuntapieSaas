import { weekday } from './stats.js';
import { REGULAR_SLOTS, SHIFT_IDS, shiftOfTime, slotKey } from './shop-hours.js';

// Ventas por empleado. No sabemos quién cobra cada ticket, pero sí en qué
// turno se vendió y quién estaba en ese turno: cada persona se lleva el total
// de los turnos en los que estaba y se compara la venta media por turno.
// Como la tarde vende más que la mañana, el «índice» compara con la media de
// la tienda en los mismos tipos de turno: 100 % = lo normal en la tienda.

export const MIN_SHIFTS_TO_RANK = 5;

const key = (day, shift) => `${day}|${shift}`;

/**
 * Devuelve una función (day, shift) → ids de quienes trabajaban: su turno
 * fijo vigente, menos vacaciones y turnos libres, más las aperturas extra.
 * Nadie cuenta antes de su inicio de contrato ni después de su baja.
 */
export function buildStaffing({ members, schedules, vacations = [], freeShifts = [], openings = [] }) {
  const versionsByUser = new Map();
  for (const v of [...schedules].sort((a, b) => a.validFrom.localeCompare(b.validFrom))) {
    versionsByUser.set(v.userId, [...(versionsByUser.get(v.userId) ?? []), v]);
  }
  const free = new Set(freeShifts.map((f) => `${f.userId}|${key(f.day, f.shift)}`));
  const extra = new Map(openings.map((o) => [key(o.day, o.shift), o.staff]));
  const cache = new Map();

  const works = (member, day, shift) => {
    if (member.contractStart && day < member.contractStart) return false;
    if (member.leftOn && day > member.leftOn) return false;
    if (vacations.some((v) => v.userId === member.id && v.start <= day && day <= v.end)) return false;
    if (free.has(`${member.id}|${key(day, shift)}`)) return false;
    const versions = versionsByUser.get(member.id) ?? [];
    const version = versions.filter((v) => v.validFrom <= day).at(-1);
    return Boolean(version?.slots.includes(slotKey(weekday(day), shift)));
  };

  return (day, shift) => {
    const k = key(day, shift);
    if (!cache.has(k)) {
      const regular = members.filter((m) => works(m, day, shift)).map((m) => m.id);
      cache.set(k, [...new Set([...regular, ...(extra.get(k) ?? [])])]);
    }
    return cache.get(k);
  };
}

function emptyShiftStats() {
  return Object.fromEntries(SHIFT_IDS.map((id) => [id, { shifts: 0, cents: 0 }]));
}

/**
 * @param {{at: string, cents: number}[]} input.sales  ventas en hora de la tienda
 * @param {{id: number, name: string}[]} input.members
 * @param {(day: string, shift: string) => number[]} input.staffing
 */
export function computeStaffStats({ sales, members, staffing }) {
  const instances = new Map();
  for (const sale of sales) {
    const day = sale.at.slice(0, 10);
    const shift = shiftOfTime(sale.at.slice(11, 16));
    const bucket = instances.get(key(day, shift)) ?? { day, shift, cents: 0, tickets: 0 };
    bucket.cents += sale.cents;
    bucket.tickets += 1;
    instances.set(key(day, shift), bucket);
  }

  const store = emptyShiftStats();
  for (const inst of instances.values()) {
    store[inst.shift].shifts += 1;
    store[inst.shift].cents += inst.cents;
  }
  const storeAvg = Object.fromEntries(SHIFT_IDS.map((id) => [id, store[id].shifts ? store[id].cents / store[id].shifts : 0]));

  const byMember = new Map(members.map((m) => [m.id, { ...m, shifts: 0, cents: 0, tickets: 0, expected: 0, byShift: emptyShiftStats() }]));
  let unstaffed = 0;
  for (const inst of instances.values()) {
    const staff = staffing(inst.day, inst.shift).filter((id) => byMember.has(id));
    if (staff.length === 0) unstaffed += 1;
    for (const id of staff) {
      const row = byMember.get(id);
      row.shifts += 1;
      row.cents += inst.cents;
      row.tickets += inst.tickets;
      row.expected += storeAvg[inst.shift];
      row.byShift[inst.shift].shifts += 1;
      row.byShift[inst.shift].cents += inst.cents;
    }
  }

  const rows = [...byMember.values()].map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active ?? true,
    shifts: r.shifts,
    cents: r.cents,
    tickets: r.tickets,
    avgPerShiftCents: r.shifts ? Math.round(r.cents / r.shifts) : 0,
    avgTicketCents: r.tickets ? Math.round(r.cents / r.tickets) : 0,
    index: r.expected ? r.cents / r.expected : null,
    byShift: Object.fromEntries(SHIFT_IDS.map((id) => [id, {
      shifts: r.byShift[id].shifts,
      avgCents: r.byShift[id].shifts ? Math.round(r.byShift[id].cents / r.byShift[id].shifts) : 0,
    }])),
    ranked: r.shifts >= MIN_SHIFTS_TO_RANK,
  })).sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || b.cents - a.cents);

  const ranked = rows.filter((r) => r.ranked);
  return {
    rows,
    best: ranked.length > 1 ? ranked[0].id : null,
    worst: ranked.length > 1 ? ranked.at(-1).id : null,
    minShiftsToRank: MIN_SHIFTS_TO_RANK,
    store: {
      shifts: instances.size,
      unstaffedShifts: unstaffed,
      byShift: Object.fromEntries(SHIFT_IDS.map((id) => [id, { shifts: store[id].shifts, avgCents: Math.round(storeAvg[id]) }])),
    },
  };
}

/**
 * Turnos de ejemplo para la simulación cuando aún no hay ninguno definido:
 * se reparten los turnos normales entre el equipo activo, alternando para que
 * cada turno tenga gente y cada persona coincida con compañeros distintos.
 */
export function simulatedSchedules(members, from) {
  if (members.length === 0) return [];
  return members.map((member, i) => ({
    userId: member.id,
    validFrom: from,
    slots: members.length === 1
      ? [...REGULAR_SLOTS]
      : REGULAR_SLOTS.filter((_, j) => (j + i) % 2 === 0 || (members.length > 3 && (j + i) % 3 === 0)),
  }));
}
