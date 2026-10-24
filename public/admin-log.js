import { api } from './api.js';
import { h, stagger } from './dom.js';
import { icon } from './icons.js';

// Admin › Log de acciones: todo lo que se hace en la aplicación, con fecha y
// hora, usuario, sección, acción, campo y valores antes y después.

const BASE_PATH = '/app/admin/log';
const FILTER_KEYS = Object.freeze(['usuario', 'area', 'accion', 'desde', 'hasta', 'q']);
const SEARCH_DELAY_MS = 300;
const stamp = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Atlantic/Canary', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const state = { filters: {}, page: 1, data: null, team: [], els: null, searchTimer: 0 };

// Tono de cada tipo de acción (siempre con su texto al lado).
function actionTone(action) {
  if (['crear', 'subir', 'reactivar', 'entrar', 'restablecer', 'pagar', 'importar'].includes(action)) return 'is-add';
  if (['borrar', 'quitar', 'baja', 'entrar_fallido', 'anular_pago'].includes(action)) return 'is-remove';
  if (action === 'salir') return 'is-neutral';
  return 'is-change';
}

function header(backHref) {
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · Seguridad' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Log de acciones' }), 1),
      stagger(h('p', { class: 'module-summary', text: 'Quién hizo qué y cuándo: cada cambio con su valor anterior y el nuevo.' }), 2),
    ])),
  ]);
}

function select(name, label, options) {
  const el = h('select', { 'data-filter': name, 'aria-label': label }, [
    h('option', { value: '', text: label }),
    ...options.map(([value, text]) => h('option', { value: String(value), text })),
  ]);
  el.value = state.filters[name] ?? '';
  return el;
}

function filterBar() {
  const d = state.data;
  const date = (name, label) => h('label', { class: 'log-date' }, [
    h('span', { text: label }),
    h('input', { type: 'date', 'data-filter': name, value: state.filters[name] ?? '' }),
  ]);
  const search = h('label', { class: 'search search-sm' }, [
    icon('search', 'ico ico-sm'),
    h('span', { class: 'sr-only', text: 'Buscar' }),
    h('input', { type: 'search', placeholder: 'Buscar en el log', 'data-filter': 'q', value: state.filters.q ?? '', autocomplete: 'off' }),
  ]);
  return h('div', { class: 'filters log-filters' }, [
    select('usuario', 'Todos los usuarios', state.team.map((m) => [m.id, m.name])),
    select('area', 'Todas las secciones', Object.entries(d.areas)),
    select('accion', 'Todas las acciones', Object.entries(d.actions)),
    date('desde', 'Desde'),
    date('hasta', 'Hasta'),
    search,
    Object.keys(state.filters).length ? h('button', { class: 'month-today', type: 'button', 'data-clear': '', text: 'Quitar filtros' }) : null,
  ]);
}

function valueCell(value, cls) {
  return h('td', { class: `log-value ${cls}` }, value === null || value === '' ? h('span', { class: 'log-none', text: '—' }) : h('span', { text: value }));
}

function table() {
  const { items, areas, actions } = state.data;
  if (!items.length) return h('p', { class: 'notice', text: 'No hay acciones con estos filtros.' });
  return h('div', { class: 'history-scroll' }, h('table', { class: 'log-table' }, [
    h('thead', {}, h('tr', {}, ['Fecha y hora', 'Usuario', 'Sección', 'Acción', 'Sobre', 'Campo', 'Antes', 'Después']
      .map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, items.map((row) => h('tr', {}, [
      h('td', { class: 'log-when', text: stamp.format(new Date(row.at)).replace(',', '') }),
      h('td', { class: 'log-user', text: row.userName || 'Desconocido' }),
      h('td', { text: areas[row.area] ?? row.area }),
      h('td', {}, h('span', { class: `log-action ${actionTone(row.action)}`, text: actions[row.action] ?? row.action })),
      h('td', { class: 'log-target', text: row.target || '—' }),
      h('td', { class: 'log-field', text: row.field ?? '—' }),
      valueCell(row.oldValue, 'is-old'),
      valueCell(row.newValue, 'is-new'),
    ]))),
  ]));
}

function pager() {
  const { page, pageSize, total } = state.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return h('div', { class: 'log-pager' }, [
    h('span', { class: 'log-count', text: `${from}–${Math.min(total, page * pageSize)} de ${total} acciones` }),
    h('button', { class: 'month-step', type: 'button', 'data-page': String(page - 1), disabled: page <= 1, 'aria-label': 'Página anterior' }, icon('arrowLeft', 'ico ico-sm')),
    h('span', { class: 'log-page', text: `Página ${page} de ${pages}` }),
    h('button', { class: 'month-step', type: 'button', 'data-page': String(page + 1), disabled: page >= pages, 'aria-label': 'Página siguiente' }, icon('arrowRight', 'ico ico-sm')),
  ]);
}

function query() {
  const params = new URLSearchParams(state.filters);
  if (state.page > 1) params.set('pagina', String(state.page));
  return params.toString();
}

function render() {
  const focused = document.activeElement?.dataset?.filter;
  state.els.body.replaceChildren(filterBar(), h('section', { class: 'stat-card is-table' }, [table(), pager()]));
  // La búsqueda no pierde el foco al refrescar la tabla.
  if (focused === 'q') {
    const input = state.els.body.querySelector('[data-filter="q"]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

async function load() {
  const q = query();
  const [res, users] = await Promise.all([
    api('GET', `/api/admin/log${q ? `?${q}` : ''}`),
    state.team.length ? null : api('GET', '/api/admin/users'),
  ]);
  if (users?.ok) state.team = users.data;
  if (!res.ok) return void state.els.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  state.data = res.data;
  history.replaceState(history.state, '', `${BASE_PATH}${q ? `?${q}` : ''}`);
  return void render();
}

function setFilter(name, value) {
  if (value) state.filters = { ...state.filters, [name]: value };
  else state.filters = Object.fromEntries(Object.entries(state.filters).filter(([k]) => k !== name));
  state.page = 1;
  load();
}

function bindEvents(root) {
  root.addEventListener('change', (event) => {
    const name = event.target.dataset?.filter;
    if (name && name !== 'q') setFilter(name, event.target.value);
  });
  root.addEventListener('input', (event) => {
    if (event.target.dataset?.filter !== 'q') return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => setFilter('q', event.target.value.trim()), SEARCH_DELAY_MS);
  });
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-clear]')) {
      state.filters = {};
      state.page = 1;
      load();
      return;
    }
    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.page);
      load();
    }
  });
}

/** Pinta Admin › Log de acciones. Los filtros viajan en la URL. */
export function renderLog({ main, params, backHref }) {
  state.filters = Object.fromEntries(FILTER_KEYS.filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
  state.page = Math.max(1, Number(params.get('pagina')) || 1);
  state.team = [];
  const body = h('div', { class: 'log-body' }, h('p', { class: 'notice', text: 'Cargando el log…' }));
  const root = h('div', { class: 'recurring log-view' }, [header(backHref), stagger(body, 3)]);
  state.els = { root, body };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Log de acciones · Puntapié';
  load();
  return root.querySelector('h1');
}
