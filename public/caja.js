import { api } from './api.js';
import { openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { centsToInput, formatEuros } from './format.js';
import { icon } from './icons.js';
import { isReadOnly } from './modules.js';
import { showToast } from './toast.js';

// Ventas › Caja diaria: mientras no esté el TPV, cada día se apunta la mañana
// (importe y clientes por método) y el cierre del día (total del TPV por
// método y clientes de la tarde). La tarde se calcula: total − mañana.

const BASE_PATH = '/app/ventas/caja';
const METHODS = Object.freeze([
  { id: 'efectivo', label: 'Efectivo' },
  { id: 'tarjeta', label: 'Tarjeta' },
  { id: 'bizum', label: 'Bizum' },
  { id: 'bonos', label: 'Bonos consumo' },
  { id: 'vales', label: 'Vales', note: 'No suman a ventas' },
]);
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const RECENT_DAYS = 31;
const DAY_MS = 86400000;

const state = { day: null, data: null, dirty: false, user: null, els: null };

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayTitle = (iso) => `${WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]} · ${iso.split('-').reverse().join('/')}`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function parseEuros(text) {
  const clean = String(text ?? '').trim().replace(/\s|€/g, '');
  if (!clean) return 0;
  const normal = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const value = Number(normal);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

const readOnly = () => isReadOnly(state.user);

/* ---------- Piezas ---------- */

function header(backHref) {
  return h('header', { class: 'module-head tone-ventas users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Ventas' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Ventas · Hasta que llegue el TPV' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Caja diaria' }), 1),
      stagger(h('p', { class: 'module-summary', text: 'Apunta la mañana y, al cerrar, los totales del TPV: la tarde se calcula sola.' }), 2),
    ])),
  ]);
}

function dayBar() {
  return h('div', { class: 'month-bar caja-bar' }, [
    h('div', { class: 'month-nav' }, [
      h('button', { class: 'month-step', type: 'button', 'data-move': '-1', 'aria-label': 'Día anterior' }, icon('arrowLeft', 'ico ico-sm')),
      h('input', { type: 'date', class: 'caja-date', 'data-date': '', 'aria-label': 'Día', max: todayIso() }),
      h('button', { class: 'month-step', type: 'button', 'data-move': '1', 'aria-label': 'Día siguiente' }, icon('arrowRight', 'ico ico-sm')),
    ]),
    h('button', { class: 'month-today', type: 'button', 'data-jump': '0', text: 'Hoy' }),
    h('button', { class: 'month-today', type: 'button', 'data-jump': '-7', text: '−7 días' }),
    h('button', { class: 'month-today', type: 'button', 'data-jump': '-14', text: '−14 días' }),
    h('label', { class: 'switch caja-festivo' }, [
      h('input', { type: 'checkbox', 'data-festivo': '' }),
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
      h('span', { class: 'switch-text' }, [h('strong', { text: 'Festivo o cerrado' }), h('small', { text: 'Ese día no se registran ventas' })]),
    ]),
  ]);
}

function moneyInput(name, cents) {
  return h('input', { type: 'text', inputmode: 'decimal', class: 'caja-input', name, value: cents ? centsToInput(cents) : '', placeholder: '0,00', autocomplete: 'off' });
}

function countInput(name, n) {
  return h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', class: 'caja-input caja-count', name, value: n ? String(n) : '', placeholder: '0', 'aria-label': 'Clientes' });
}

function methodLabel(m) {
  return h('span', { class: 'caja-method' }, [h('strong', { text: m.label }), m.note ? h('small', { text: m.note }) : null]);
}

function morningCard(d) {
  return h('section', { class: 'caja-card' }, [
    h('header', { class: 'caja-card-head' }, [h('h2', { text: 'Mañana' }), h('span', { class: 'caja-card-total', 'data-total': 'manana' })]),
    h('div', { class: 'caja-grid' }, [
      h('span'), h('span', { class: 'caja-col', text: 'Importe' }), h('span', { class: 'caja-col', text: 'Clientes' }),
      ...METHODS.flatMap((m) => [
        methodLabel(m),
        moneyInput(`manana-${m.id}`, d.manana[m.id].cents),
        countInput(`manana-c-${m.id}`, d.manana[m.id].customers),
      ]),
    ]),
  ]);
}

function closingCard(d) {
  return h('section', { class: 'caja-card is-closing' }, [
    h('header', { class: 'caja-card-head' }, [
      h('div', {}, [h('h2', { text: 'Cierre del día (totales del TPV)' }), h('p', { text: 'Total del día por método (mañana + tarde). La tarde se calcula sola.' })]),
      h('span', { class: 'caja-card-total', 'data-total': 'dia' }),
    ]),
    h('div', { class: 'caja-grid' }, [
      h('span'), h('span', { class: 'caja-col', text: 'Total día (TPV)' }), h('span', { class: 'caja-col', text: 'Clientes tarde' }),
      ...METHODS.flatMap((m) => [
        methodLabel(m),
        h('div', { class: 'caja-cell' }, [
          moneyInput(`dia-${m.id}`, d.manana[m.id].cents + d.tarde[m.id].cents),
          h('small', { class: 'caja-afternoon', 'data-afternoon': m.id }),
        ]),
        countInput(`tarde-c-${m.id}`, d.tarde[m.id].customers),
      ]),
    ]),
    h('p', { class: 'caja-afternoon-total', 'data-total': 'tarde' }),
  ]);
}

function footer() {
  return h('div', { class: 'caja-foot' }, [
    h('div', { class: 'caja-foot-parts', 'data-foot': '' }),
    h('button', { class: 'cta caja-save', type: 'button', 'data-save': '', 'data-write': '' }, [
      h('span', { text: 'Guardar el día' }),
      h('span', { class: 'bubble bubble-cta' }, icon('cardPos', 'ico ico-sm')),
    ]),
  ]);
}

/* ---------- Cálculo en vivo ---------- */

function readForm() {
  const form = state.els.form;
  const val = (name) => form.querySelector(`[name="${name}"]`)?.value ?? '';
  const lines = { manana: {}, dia: {}, tarde: {} };
  const errors = [];
  for (const m of METHODS) {
    const morning = parseEuros(val(`manana-${m.id}`));
    const total = parseEuros(val(`dia-${m.id}`));
    if (morning === null || total === null) errors.push(`${m.label}: importe no válido.`);
    lines.manana[m.id] = { importe: val(`manana-${m.id}`), clientes: val(`manana-c-${m.id}`), cents: morning ?? 0 };
    lines.dia[m.id] = { importe: val(`dia-${m.id}`), cents: total ?? 0 };
    lines.tarde[m.id] = { clientes: val(`tarde-c-${m.id}`) };
  }
  return { lines, errors };
}

function recompute() {
  const { lines } = readForm();
  const form = state.els.form;
  const count = (name) => Number(form.querySelector(`[name="${name}"]`)?.value || 0);
  let morning = 0;
  let day = 0;
  let morningClients = 0;
  let afternoonClients = 0;
  let vales = 0;
  for (const m of METHODS) {
    const mm = lines.manana[m.id].cents;
    const dd = lines.dia[m.id].cents;
    const afternoon = dd - mm;
    const hint = form.querySelector(`[data-afternoon="${m.id}"]`);
    hint.textContent = afternoon < 0 ? 'El total no puede ser menor que la mañana' : `Tarde calculada: ${formatEuros(Math.max(0, afternoon))}`;
    hint.classList.toggle('is-bad', afternoon < 0);
    if (m.id === 'vales') {
      vales += dd;
      continue;
    }
    morning += mm;
    day += dd;
    morningClients += count(`manana-c-${m.id}`);
    afternoonClients += count(`tarde-c-${m.id}`);
  }
  const afternoon = day - morning;
  form.querySelector('[data-total="manana"]').replaceChildren(h('strong', { text: formatEuros(morning) }), ` · ${morningClients} clientes`);
  form.querySelector('[data-total="dia"]').replaceChildren(h('strong', { text: formatEuros(day) }));
  form.querySelector('[data-total="tarde"]').replaceChildren(h('strong', { text: 'Tarde total: ' }), h('span', { text: formatEuros(Math.max(0, afternoon)) }), ` · ${afternoonClients} clientes`);
  state.els.root.querySelector('[data-foot]').replaceChildren(...[
    h('span', {}, ['Mañana: ', h('strong', { text: formatEuros(morning) })]),
    h('span', {}, ['Tarde: ', h('strong', { text: formatEuros(Math.max(0, afternoon)) })]),
    vales ? h('span', { class: 'caja-vales' }, ['Vales (no suman): ', h('strong', { text: formatEuros(vales) })]) : null,
    h('span', { class: 'caja-total' }, ['Total día: ', h('strong', { text: formatEuros(day) })]),
  ].filter(Boolean));
}

/* ---------- Pantalla ---------- */

function renderDay() {
  const d = state.data;
  const festivo = d.status !== 'abierto';
  state.els.title.textContent = dayTitle(d.day);
  state.els.root.querySelector('[data-date]').value = d.day;
  state.els.root.querySelector('[data-festivo]').checked = festivo;
  state.els.root.querySelector('[data-move="1"]').disabled = d.day >= todayIso();
  const form = h('fieldset', { class: 'caja-form', disabled: festivo || readOnly() }, [morningCard(d), closingCard(d)]);
  state.els.form = form;
  state.els.status.replaceChildren(
    d.exists ? h('span', { class: 'status status-ok', text: festivo ? 'Guardado como festivo o cerrado' : 'Día guardado' }) : h('span', { class: 'status status-wait', text: 'Sin apuntar' }),
    d.extendedHours ? h('span', { class: 'status status-soft', text: 'Horario ampliado' }) : null,
  );
  state.els.body.replaceChildren(form);
  recompute();
  state.dirty = false;
}

async function recent() {
  const to = todayIso();
  const res = await api('GET', `/api/ventas/dias?desde=${addDays(to, -RECENT_DAYS)}&hasta=${to}`);
  if (!res.ok) return;
  const byDay = new Map(res.data.map((x) => [x.day, x]));
  const days = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(to, -i));
  state.els.recent.replaceChildren(
    h('h2', { class: 'caja-recent-title', text: 'Últimos días' }),
    h('ul', { class: 'caja-recent' }, days.map((day) => {
      const x = byDay.get(day);
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      const label = x ? (x.status !== 'abierto' ? 'Festivo' : formatEuros(x.cents)) : weekday === 0 ? 'Domingo' : 'Sin apuntar';
      return h('li', {}, h('button', {
        type: 'button',
        class: `caja-day${day === state.day ? ' is-current' : ''}${x ? '' : weekday === 0 ? ' is-closed' : ' is-missing'}`,
        'data-open-day': day,
      }, [
        h('span', { class: 'caja-day-date', text: `${WEEKDAYS[weekday].slice(0, 3)} ${day.slice(8)}/${day.slice(5, 7)}` }),
        h('span', { class: 'caja-day-total', text: label }),
      ]));
    })),
  );
}

async function load(day) {
  const res = await api('GET', `/api/ventas/dia/${day}`);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  state.day = day;
  state.data = res.data;
  history.replaceState(history.state, '', `${BASE_PATH}?dia=${day}`);
  renderDay();
  return void recent();
}

async function goTo(day) {
  if (!isDay(day) || day > todayIso()) return;
  if (state.dirty) {
    const discard = await openDialog({
      eyebrow: 'Cambios sin guardar',
      title: '¿Cambiar de día sin guardar?',
      lead: `Lo que has escrito en el ${state.day.split('-').reverse().join('/')} se perderá.`,
      submitLabel: 'Descartar y cambiar',
      tone: 'danger',
      onSubmit: async () => true,
    });
    if (!discard) return;
  }
  await load(day);
}

async function save() {
  const { lines, errors } = readForm();
  if (errors.length) return void showToast(errors[0], { tone: 'error' });
  const festivo = state.els.root.querySelector('[data-festivo]').checked;
  const body = {
    status: festivo ? 'festivo' : 'abierto',
    manana: Object.fromEntries(METHODS.map((m) => [m.id, { importe: lines.manana[m.id].importe, clientes: lines.manana[m.id].clientes }])),
    dia: Object.fromEntries(METHODS.map((m) => [m.id, { importe: lines.dia[m.id].importe }])),
    tarde: Object.fromEntries(METHODS.map((m) => [m.id, { clientes: lines.tarde[m.id].clientes }])),
  };
  const res = await api('PUT', `/api/ventas/dia/${state.day}`, body);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  state.data = res.data;
  renderDay();
  showToast(festivo ? 'Día guardado como festivo.' : `Caja del ${state.day.split('-').reverse().join('/')} guardada: ${formatEuros(res.data.totals.manana.cents + res.data.totals.tarde.cents)}.`);
  return void recent();
}

function importBlock() {
  const status = h('p', { class: 'field-hint', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true });
  const block = h('section', { class: 'caja-import' }, [
    h('h2', { class: 'caja-recent-title', text: 'Importar ventas de la app antigua' }),
    h('p', { class: 'field-hint', text: 'Sube el ZIP exportado (o ventas_puntapie.json). Los días que ya estén apuntados no se tocan; se corrigen las erratas de clientes señaladas en incidencias.csv y se traen los gastos diarios que no son pagos a proveedores.' }),
    h('button', { class: 'btn-chip', type: 'button', 'data-import': '', text: 'Subir exportación…' }),
    input,
    status,
  ]);
  block.querySelector('[data-import]').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    status.textContent = `Importando «${file.name}»…`;
    let res;
    try {
      const r = await fetch('/api/ventas/importar', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
      });
      res = await r.json();
    } catch {
      res = { ok: false, error: 'No hay conexión con el servidor.' };
    }
    if (!res.ok) {
      status.textContent = '';
      return void showToast(res.error, { tone: 'error' });
    }
    const x = res.data;
    status.textContent = [
      `${x.dias} días importados (${formatEuros(x.totalCents)}, ${x.clientes} clientes)${x.yaEstaban ? `; ${x.yaEstaban} ya estaban` : ''}.`,
      x.cuadra === true ? 'Cuadra con el total de la exportación.' : x.cuadra === false ? 'Atención: no cuadra con el total de la exportación.' : null,
      x.erratas.length ? `Erratas corregidas: ${x.erratas.join('; ')}.` : null,
      x.gastos ? `${x.gastos} gastos diarios añadidos como esporádicos (${formatEuros(x.gastosCents)}).` : null,
      x.gastosOmitidos.length ? `No se importan (pagos a proveedores, ya en su gestor): ${x.gastosOmitidos.join('; ')}.` : null,
    ].filter(Boolean).join(' ');
    showToast('Ventas importadas.');
    return void load(state.day);
  });
  return block;
}

function bindEvents(root) {
  root.addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) return void goTo(addDays(state.day, Number(move.dataset.move)));
    const jump = e.target.closest('[data-jump]');
    if (jump) return void goTo(addDays(todayIso(), Number(jump.dataset.jump)));
    const open = e.target.closest('[data-open-day]');
    if (open) return void goTo(open.dataset.openDay);
    if (e.target.closest('[data-save]')) return void save();
    return undefined;
  });
  root.addEventListener('input', (e) => {
    if (!e.target.closest('.caja-form')) return;
    state.dirty = true;
    recompute();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-date]')) return void goTo(e.target.value);
    if (e.target.matches('[data-festivo]')) {
      state.dirty = true;
      state.els.form.disabled = e.target.checked || readOnly();
    }
    return undefined;
  });
}

/** Pinta Ventas › Caja diaria. Admite ?dia=AAAA-MM-DD. */
export function renderCaja({ main, user, params, backHref }) {
  state.user = user;
  state.dirty = false;
  const day = isDay(params.get('dia')) && params.get('dia') <= todayIso() ? params.get('dia') : todayIso();
  const title = h('h2', { class: 'caja-title' });
  const status = h('div', { class: 'caja-status' });
  const body = h('div', { class: 'caja-body' }, h('p', { class: 'notice', text: 'Cargando…' }));
  const recentBox = h('section', { class: 'caja-recent-box' });
  const root = h('div', { class: 'recurring caja-view' }, [
    header(backHref),
    stagger(h('div', { class: 'caja-day-head' }, [title, status]), 2),
    stagger(dayBar(), 2),
    stagger(body, 3),
    stagger(footer(), 3),
    stagger(recentBox, 4),
    user.role === 'admin' ? stagger(importBlock(), 4) : null,
  ]);
  state.els = { root, body, title, status, recent: recentBox };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Caja diaria · Puntapié';
  load(day);
  return root.querySelector('h1');
}
