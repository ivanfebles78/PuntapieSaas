import { SHIFT_NAMES, formatDate, formatHours, shiftTimes, shopHours, todayIso, weekdayOf } from './admin-shifts.js';
import { api } from './api.js';
import { field, openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { currentMonth } from './format.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

// Admin › Aperturas extra: sábados por la tarde y domingos por la mañana que
// se abren de forma puntual (p. ej. la campaña de bonos consumo) y quién los trabaja.

const LONG_WEEKDAYS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// Huecos que solo se abren de forma puntual: [día de la semana, turno].
const EXTRA = Object.freeze({ domingo: [7, 'manana'], sabado: [6, 'tarde'] });

const state = { openings: [], team: [], hours: null, els: null };

const longDate = (iso) => `${LONG_WEEKDAYS[weekdayOf(iso)]} ${Number(iso.slice(8))} de ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Días de `month` («AAAA-MM») que caen en `weekday`. */
function daysOfMonth(month, weekday) {
  const [y, m] = month.split('-').map(Number);
  const days = [];
  for (let d = 1; d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); d += 1) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (weekdayOf(iso) === weekday) days.push(iso);
  }
  return days;
}

function header(backHref) {
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, [
      h('div', {}, [
        stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · Turnos' }), 1),
        stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Aperturas extra' }), 1),
        stagger(h('p', { class: 'module-summary', text: 'Sábados por la tarde y domingos que abrimos de forma puntual, y quién los trabaja.' }), 2),
      ]),
      stagger(h('button', { class: 'cta', type: 'button', 'data-new-opening': '' }, [
        h('span', { text: 'Nueva apertura' }),
        h('span', { class: 'bubble bubble-cta' }, icon('calendar', 'ico ico-sm')),
      ]), 2),
    ]),
  ]);
}

function rules() {
  const hours = state.hours;
  const bonus = formatHours(hours.shiftMinutes * hours.bonusMultiplier);
  return h('ul', { class: 'opening-rules' }, [
    h('li', {}, [icon('calendar', 'ico ico-sm'), h('span', { text: `Sábado tarde ${shiftTimes(hours, 'tarde')}` })]),
    h('li', {}, [icon('calendar', 'ico ico-sm'), h('span', { text: `Domingo mañana ${shiftTimes(hours, 'manana')}` })]),
    h('li', { class: 'is-bonus' }, [icon('flash', 'ico ico-sm'), h('span', { text: `Cada persona gana ${bonus} de descanso por turno (2 h por hora)` })]),
  ]);
}

function staffChips(staff) {
  if (!staff.length) return h('span', { class: 'opening-nobody', text: 'Sin nadie asignado' });
  return h('ul', { class: 'staff-chips' }, staff.map((p) => h('li', { text: p.name })));
}

function openingCard(opening) {
  const weekday = weekdayOf(opening.day);
  return h('li', { class: `opening${opening.done ? ' is-done' : ''}`, 'data-opening': String(opening.id) }, [
    h('span', { class: 'opening-date' }, [
      h('span', { class: 'opening-dow', text: LONG_WEEKDAYS[weekday].slice(0, 3) }),
      h('span', { class: 'opening-day', text: String(Number(opening.day.slice(8))) }),
      h('span', { class: 'opening-month', text: MONTHS[Number(opening.day.slice(5, 7)) - 1].slice(0, 3) }),
    ]),
    h('span', { class: 'opening-body' }, [
      h('span', { class: 'opening-title', text: `${LONG_WEEKDAYS[weekday]} ${SHIFT_NAMES[opening.shift].toLowerCase()} · ${shiftTimes(state.hours, opening.shift)}` }),
      h('span', { class: 'opening-meta', text: [longDate(opening.day), opening.done ? 'trabajada' : 'programada', opening.note].filter(Boolean).join(' · ') }),
      staffChips(opening.staff),
    ]),
    h('span', { class: 'opening-bonus', text: `+${formatHours(opening.bonusMinutes)} c/u` }),
    h('span', { class: 'member-actions' }, [
      h('button', { class: 'act', type: 'button', 'data-edit-opening': '', title: 'Cambiar equipo', 'aria-label': 'Cambiar equipo' }, [icon('people', 'ico ico-sm'), h('span', { class: 'act-label', text: 'Equipo' })]),
      h('button', { class: 'act act-danger', type: 'button', 'data-delete-opening': '', title: 'Borrar apertura', 'aria-label': 'Borrar apertura' }, [icon('close', 'ico ico-sm'), h('span', { class: 'act-label', text: 'Borrar' })]),
    ]),
  ]);
}

function section(title, list, empty) {
  return h('section', { class: 'opening-section' }, [
    h('h2', { class: 'opening-heading' }, [h('span', { text: title }), h('span', { class: 'opening-count', text: String(list.length) })]),
    h('ul', { class: 'opening-list' }, list.length ? list.map(openingCard) : h('li', { class: 'vac-empty', text: empty })),
  ]);
}

function render() {
  const upcoming = state.openings.filter((o) => !o.done).reverse();
  const past = state.openings.filter((o) => o.done);
  state.els.body.replaceChildren(
    rules(),
    section('Próximas', upcoming, 'No hay aperturas extra programadas.'),
    section('Ya trabajadas', past, 'Todavía no se ha abierto ningún sábado por la tarde ni domingo.'),
  );
}

async function load() {
  const [openings, users, hours] = await Promise.all([api('GET', '/api/admin/aperturas'), api('GET', '/api/admin/users'), shopHours()]);
  if (!openings.ok || !users.ok) {
    state.els.body.replaceChildren(h('p', { class: 'notice', text: openings.error ?? users.error }));
    return;
  }
  state.openings = openings.data;
  state.team = users.data.filter((u) => u.status === 'activo');
  state.hours = hours;
  render();
}

function staffPicker(selected = []) {
  return h('fieldset', { class: 'staff-picker' }, [
    h('legend', { text: '¿Quién trabaja?' }),
    ...state.team.map((m) => h('label', { class: 'staff-option' }, [
      h('input', { type: 'checkbox', name: 'staff', value: String(m.id), checked: selected.includes(m.id) }),
      h('span', { text: m.name }),
      // Con dos nombres iguales, el usuario los distingue.
      state.team.filter((x) => x.name === m.name).length > 1
        ? h('small', { class: 'staff-handle', text: m.username ? `@${m.username}` : m.email }) : null,
    ])),
  ]);
}

const checkedStaff = (form) => [...form.querySelectorAll('input[name="staff"]:checked')].map((i) => Number(i.value));

function readDays(form) {
  const value = (name) => form.elements.namedItem(name).value;
  const [weekday, shift] = EXTRA[value('kind')];
  if (value('mode') === 'mes') return daysOfMonth(value('month'), weekday).map((day) => ({ day, shift }));
  if (weekdayOf(value('day')) !== weekday) {
    return { error: weekday === 7 ? 'Esa fecha no es domingo.' : 'Esa fecha no es sábado.' };
  }
  return [{ day: value('day'), shift }];
}

async function newOpening() {
  const radio = (name, value, label, checked) => h('label', { class: 'chip-radio' }, [h('input', { type: 'radio', name, value, checked }), h('span', { text: label })]);
  const saved = await openDialog({
    eyebrow: 'Apertura extra',
    title: 'Abrir fuera del horario',
    lead: 'Puede ser un día suelto o todos los domingos (o sábados por la tarde) de un mes, como en la campaña de bonos consumo.',
    content: [
      h('div', { class: 'chip-radios', role: 'group', 'aria-label': 'Qué se abre' }, [
        radio('kind', 'domingo', `Domingo mañana (${shiftTimes(state.hours, 'manana')})`, true),
        radio('kind', 'sabado', `Sábado tarde (${shiftTimes(state.hours, 'tarde')})`, false),
      ]),
      h('div', { class: 'chip-radios', role: 'group', 'aria-label': 'Cuándo' }, [
        radio('mode', 'dia', 'Un día', true),
        radio('mode', 'mes', 'Todos los de un mes', false),
      ]),
      h('div', { class: 'vac-form' }, [
        field({ label: 'Día (si es uno)', name: 'day', type: 'date', value: todayIso() }),
        field({ label: 'Mes (si son todos)', name: 'month', type: 'month', value: currentMonth() }),
      ]),
      staffPicker(),
      field({ label: 'Nota (opcional)', name: 'note', autocomplete: 'off', hint: 'Por ejemplo: campaña de bonos consumo.' }),
    ],
    submitLabel: 'Guardar apertura',
    onSubmit: async (form) => {
      const days = readDays(form);
      if (days.error) return days;
      const staff = checkedStaff(form);
      const note = form.elements.namedItem('note').value;
      const errors = [];
      for (const d of days) {
        const res = await api('POST', '/api/admin/aperturas', { ...d, staff, note });
        if (!res.ok) errors.push(`${formatDate(d.day)}: ${res.error}`);
      }
      if (errors.length === days.length) return { error: errors.join(' ') };
      return { created: days.length - errors.length, errors };
    },
  });
  if (!saved) return;
  const month = saved.created > 1 ? ` (${saved.created} días)` : '';
  showToast(saved.errors.length ? `Guardadas ${saved.created}. ${saved.errors.join(' ')}` : `Apertura guardada${month}.`, { tone: saved.errors.length ? 'error' : undefined });
  await load();
}

async function editStaff(opening) {
  const saved = await openDialog({
    eyebrow: longDate(opening.day),
    title: `${SHIFT_NAMES[opening.shift]} · ${shiftTimes(state.hours, opening.shift)}`,
    lead: 'Cada persona marcada suma las horas de descanso cuando llegue el día.',
    content: [
      staffPicker(opening.staff.map((p) => p.id)),
      field({ label: 'Nota (opcional)', name: 'note', value: opening.note, autocomplete: 'off' }),
    ],
    submitLabel: 'Guardar equipo',
    onSubmit: async (form) => {
      // Quien ya no está activo se conserva en las aperturas pasadas.
      const inactive = opening.staff.filter((p) => !state.team.some((m) => m.id === p.id)).map((p) => p.id);
      const res = await api('PATCH', `/api/admin/aperturas/${opening.id}`, { staff: [...checkedStaff(form), ...inactive], note: form.elements.namedItem('note').value });
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!saved) return;
  showToast('Equipo guardado.');
  await load();
}

async function deleteOpening(opening) {
  const done = await openDialog({
    eyebrow: 'Borrar',
    title: `¿Borrar la apertura del ${formatDate(opening.day)}?`,
    lead: opening.staff.length
      ? `${opening.staff.map((p) => p.name).join(', ')} perderán las ${formatHours(opening.bonusMinutes)} de descanso que suma.`
      : 'No tiene a nadie asignado.',
    submitLabel: 'Borrar',
    tone: 'danger',
    onSubmit: async () => {
      const res = await api('DELETE', `/api/admin/aperturas/${opening.id}`);
      return res.ok ? true : { error: res.error };
    },
  });
  if (!done) return;
  showToast('Apertura borrada.');
  await load();
}

function bindEvents(root) {
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-new-opening]')) return void newOpening();
    const card = event.target.closest('[data-opening]');
    if (!card) return undefined;
    const opening = state.openings.find((o) => o.id === Number(card.dataset.opening));
    if (event.target.closest('[data-edit-opening]')) return void editStaff(opening);
    if (event.target.closest('[data-delete-opening]')) return void deleteOpening(opening);
    return undefined;
  });
}

/** Pinta Admin › Aperturas extra. */
export function renderOpenings({ main, backHref }) {
  const body = h('div', { class: 'openings-body' }, h('p', { class: 'notice', text: 'Cargando…' }));
  const root = h('div', { class: 'users openings' }, [header(backHref), stagger(body, 3)]);
  state.els = { root, body };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Aperturas extra · Puntapié';
  load();
  return root.querySelector('h1');
}
