import { api } from './api.js';
import { field, openDialog } from './dialogs.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

// Turno fijo de cada persona y sus horas bonificadas (aperturas extra
// trabajadas y turnos libres pedidos con ellas).

export const SHIFT_NAMES = Object.freeze({ manana: 'Mañana', tarde: 'Tarde' });
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const LONG_WEEKDAYS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const PRESETS = Object.freeze([
  ['todo', 'Todos los turnos'],
  ['mananas', 'Solo mañanas'],
  ['tardes', 'Solo tardes'],
  ['nada', 'Ninguno'],
]);

let hoursCache = null;

/** Horario de la tienda (turnos, horas y huecos válidos), pedido una vez. */
export async function shopHours() {
  if (!hoursCache) {
    const res = await api('GET', '/api/admin/horario');
    if (!res.ok) throw new Error(res.error);
    hoursCache = res.data;
  }
  return hoursCache;
}

export const formatDate = (iso) => iso.split('-').reverse().join('/');
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' }).format(new Date());
export const weekdayOf = (iso) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** 420 → «7 h»; 210 → «3,5 h». */
export function formatHours(minutes) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace('.', ',')} h`;
}

export function shiftTimes(hours, shift) {
  const s = hours.shifts.find((x) => x.id === shift);
  return `${s.start}–${s.end}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** «Lunes a viernes mañana · sábado mañana» en texto corto. */
export function describeSlots(slots) {
  if (!slots?.length) return 'Sin turno asignado';
  return ['manana', 'tarde'].map((shift) => {
    const days = slots.filter((s) => s.endsWith(`-${shift}`)).map((s) => Number(s.split('-')[0]));
    if (!days.length) return null;
    const names = days.length === 5 && !days.includes(6) ? 'L a V' : days.length === 6 ? 'L a S' : days.map((d) => WEEKDAYS[d - 1]).join(', ');
    return `${SHIFT_NAMES[shift]}: ${names}`;
  }).filter(Boolean).join(' · ');
}

/* ---------- Turno fijo ---------- */

function slotGrid(hours, selected) {
  const cell = (day, shift) => {
    const slot = `${day}-${shift}`;
    if (!hours.regularSlots.includes(slot)) {
      return h('span', { class: 'slot slot-closed', title: 'Cerrado: solo se abre de forma puntual' }, h('span', { text: 'Cerrado' }));
    }
    return h('label', { class: `slot slot-${shift}` }, [
      h('input', { type: 'checkbox', name: 'slot', value: slot, checked: selected.includes(slot) }),
      h('span', { class: 'slot-face', 'aria-hidden': 'true' }, icon('userTick', 'ico ico-xs')),
      h('span', { class: 'sr-only', text: `${LONG_WEEKDAYS[day]} ${SHIFT_NAMES[shift].toLowerCase()}` }),
    ]);
  };
  return h('div', { class: 'slot-grid', role: 'group', 'aria-label': 'Turnos de la semana' }, [
    h('span', { class: 'slot-corner' }),
    ...WEEKDAYS.map((d) => h('span', { class: 'slot-day', text: d })),
    ...['manana', 'tarde'].flatMap((shift) => [
      h('span', { class: 'slot-shift' }, [h('strong', { text: SHIFT_NAMES[shift] }), h('small', { text: shiftTimes(hours, shift) })]),
      ...[1, 2, 3, 4, 5, 6].map((day) => cell(day, shift)),
    ]),
  ]);
}

function applyPreset(grid, preset) {
  grid.querySelectorAll('input[name="slot"]').forEach((input) => {
    input.checked = preset === 'todo' || (preset === 'mananas' && input.value.endsWith('manana')) || (preset === 'tardes' && input.value.endsWith('tarde'));
  });
}

function weeklyHours(grid, hours) {
  const n = grid.querySelectorAll('input[name="slot"]:checked').length;
  return `${plural(n, 'turno', 'turnos')} a la semana · ${formatHours(n * hours.shiftMinutes)}`;
}

/** Diálogo del turno fijo: mañana y/o tarde, día a día, desde una fecha. */
export async function manageSchedule(member) {
  const [hours, res] = await Promise.all([shopHours(), api('GET', `/api/admin/users/${member.id}/turno`)]);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  const current = res.data.upcoming.at(-1) ?? res.data.current;
  const selected = current?.slots ?? [];
  const total = h('p', { class: 'slot-total', 'aria-live': 'polite' });
  const presets = h('div', { class: 'slot-presets' }, PRESETS.map(([id, label]) => h('button', { class: 'chip-btn', type: 'button', 'data-preset': id, text: label })));
  const grid = slotGrid(hours, selected);
  const updateTotal = () => { total.textContent = weeklyHours(grid, hours); };
  updateTotal();
  grid.addEventListener('change', updateTotal);
  presets.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-preset]');
    if (!preset) return;
    applyPreset(grid, preset.dataset.preset);
    updateTotal();
  });
  const upcoming = res.data.upcoming.length
    ? h('p', { class: 'field-hint', text: `Cambio programado: desde el ${formatDate(res.data.upcoming[0].validFrom)} (${describeSlots(res.data.upcoming[0].slots)}).` })
    : null;

  const saved = await openDialog({
    eyebrow: 'Turno',
    title: `Turno de ${member.name}`,
    lead: `Marca los turnos que trabaja cada semana. Lunes a viernes de ${shiftTimes(hours, 'manana')} y de ${shiftTimes(hours, 'tarde')}; sábado solo por la mañana.`,
    content: [
      presets,
      grid,
      total,
      field({ label: 'Válido desde', name: 'validFrom', type: 'date', value: todayIso(), required: true, hint: 'Los turnos anteriores a esta fecha no cambian: las estadísticas de esos días siguen igual.' }),
      upcoming,
    ],
    submitLabel: 'Guardar turno',
    onSubmit: async (form) => {
      const slots = [...form.querySelectorAll('input[name="slot"]:checked')].map((i) => i.value);
      const r = await api('PUT', `/api/admin/users/${member.id}/turno`, { slots, validFrom: form.elements.namedItem('validFrom').value });
      return r.ok ? r.data : { error: r.error };
    },
  });
  if (!saved) return;
  showToast(`Turno de ${member.name} guardado.`);
}

/* ---------- Horas bonificadas (dentro de Vacaciones) ---------- */

function bonusTiles(data) {
  const tile = (label, value, detail, extra = '') => h('div', { class: `vac-stat ${extra}` }, [
    h('span', { class: 'vac-stat-num', text: value }),
    h('span', { class: 'vac-stat-label', text: label }),
    detail ? h('span', { class: 'vac-stat-detail', text: detail }) : null,
  ]);
  return h('div', { class: 'vac-stats' }, [
    tile('Ganadas', formatHours(data.earnedMinutes), 'Aperturas extra ya trabajadas'),
    tile('Por ganar', formatHours(data.pendingMinutes), 'Aperturas programadas'),
    tile('Usadas', formatHours(data.usedMinutes), plural(data.freeShifts.length, 'turno libre', 'turnos libres')),
    tile(data.balanceMinutes < 0 ? 'Debe' : 'Disponibles', formatHours(Math.abs(data.balanceMinutes)),
      data.balanceMinutes < 0 ? 'Usó más de las ganadas' : `= ${plural(data.freeShiftsAvailable, 'turno libre', 'turnos libres')}`,
      data.balanceMinutes < 0 ? 'vac-stat-over' : 'vac-stat-left bonus-left'),
  ]);
}

function bonusList(data, hours) {
  const items = [
    ...data.openings.map((o) => ({ day: o.day, node: h('li', { class: 'vac' }, [
      h('span', { class: 'vac-icon bonus-plus' }, icon('flash', 'ico ico-sm')),
      h('span', { class: 'vac-text' }, [
        h('span', { class: 'vac-range', text: `+${formatHours(o.bonusMinutes)} · ${LONG_WEEKDAYS[weekdayOf(o.day)]} ${formatDate(o.day)}` }),
        h('span', { class: 'vac-meta', text: [`Apertura extra · ${SHIFT_NAMES[o.shift].toLowerCase()} ${shiftTimes(hours, o.shift)}`, o.done ? null : 'aún no trabajada', o.note].filter(Boolean).join(' · ') }),
      ]),
    ]) })),
    ...data.freeShifts.map((f) => ({ day: f.day, node: h('li', { class: 'vac' }, [
      h('span', { class: 'vac-icon bonus-minus' }, icon('sun', 'ico ico-sm')),
      h('span', { class: 'vac-text' }, [
        h('span', { class: 'vac-range', text: `−${formatHours(data.shiftMinutes)} · ${LONG_WEEKDAYS[weekdayOf(f.day)]} ${formatDate(f.day)}` }),
        h('span', { class: 'vac-meta', text: [`Turno libre · ${SHIFT_NAMES[f.shift].toLowerCase()}`, f.note].filter(Boolean).join(' · ') }),
      ]),
      h('button', { class: 'act act-danger', type: 'button', 'data-remove-free': String(f.id), 'aria-label': 'Borrar turno libre', title: 'Borrar turno libre' },
        [icon('close', 'ico ico-sm'), h('span', { class: 'act-label', text: 'Borrar' })]),
    ]) })),
  ].sort((a, b) => b.day.localeCompare(a.day));
  return items.length ? items.map((i) => i.node) : [h('li', { class: 'vac-empty', text: 'Sin aperturas extra ni turnos libres todavía.' })];
}

/**
 * Bloque de horas bonificadas para el diálogo de Vacaciones: saldo, historial
 * y un mini formulario para pedir un turno libre (3,5 h cada uno).
 */
export function bonusSection(member, { onChange } = {}) {
  const summary = h('div', { 'aria-live': 'polite' });
  const list = h('ul', { class: 'vac-list', 'aria-live': 'polite' }, h('li', { class: 'vac-empty', text: 'Cargando…' }));
  const day = h('input', { type: 'date', id: `free-day-${member.id}`, value: todayIso() });
  const shift = h('select', { id: `free-shift-${member.id}` }, [h('option', { value: 'manana', text: 'Mañana' }), h('option', { value: 'tarde', text: 'Tarde' })]);
  const note = h('input', { type: 'text', id: `free-note-${member.id}`, placeholder: 'Nota (opcional)', autocomplete: 'off' });
  const add = h('button', { class: 'btn-chip', type: 'button', 'data-add-free': '', text: 'Pedir turno libre' });

  const render = (data, hours) => {
    summary.replaceChildren(bonusTiles(data));
    list.replaceChildren(...bonusList(data, hours));
  };
  const refresh = async () => {
    const [hours, res] = await Promise.all([shopHours(), api('GET', `/api/admin/users/${member.id}/horas`)]);
    if (!res.ok) return void list.replaceChildren(h('li', { class: 'vac-empty', text: res.error }));
    return render(res.data, hours);
  };

  const node = h('section', { class: 'bonus' }, [
    h('p', { class: 'vac-heading', text: 'Horas bonificadas · sábados tarde y domingos' }),
    h('p', { class: 'field-hint bonus-lead', text: 'Cada turno extra trabajado (3,5 h) suma 7 h de descanso. Se usan pidiendo turnos libres de 3,5 h, aparte de los días de vacaciones.' }),
    summary,
    list,
    h('div', { class: 'bonus-form' }, [
      h('div', { class: 'field' }, [h('label', { for: day.id, text: 'Día libre' }), day]),
      h('div', { class: 'field' }, [h('label', { for: shift.id, text: 'Turno' }), shift]),
      h('div', { class: 'field bonus-note' }, [h('label', { for: note.id, text: 'Nota' }), note]),
      add,
    ]),
  ]);

  node.addEventListener('click', async (event) => {
    if (event.target.closest('[data-add-free]')) {
      const res = await api('POST', `/api/admin/users/${member.id}/horas`, { day: day.value, shift: shift.value, note: note.value });
      if (!res.ok) return void showToast(res.error, { tone: 'error' });
      note.value = '';
      render(res.data, await shopHours());
      onChange?.();
      return void showToast(`Turno libre apuntado: le quedan ${formatHours(res.data.balanceMinutes)}.`);
    }
    const remove = event.target.closest('[data-remove-free]');
    if (!remove) return undefined;
    const res = await api('DELETE', `/api/admin/users/${member.id}/horas/${remove.dataset.removeFree}`);
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    render(res.data, await shopHours());
    onChange?.();
    return void showToast('Turno libre borrado: las horas vuelven a su saldo.');
  });

  return { node, refresh };
}
