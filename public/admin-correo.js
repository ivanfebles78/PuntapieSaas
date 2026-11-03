import { api } from './api.js';
import { h, stagger } from './dom.js';
import { formatEuros } from './format.js';
import { icon } from './icons.js';
import { openSupplierManager } from './proveedores/manager.js';

// Admin › Asistente de correo: cada correo que revisó el asistente, si lo
// marcó como leído (y cuándo) y qué hizo con cada PDF, con enlace a la
// factura o al gasto que registró. Para poder revisar lo que hizo solo.

const BASE_PATH = '/app/admin/asistente';
const FILTER_KEYS = Object.freeze(['resultado', 'leido', 'desde', 'hasta', 'q']);
const SEARCH_DELAY_MS = 300;
const stamp = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Atlantic/Canary', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const when = (iso) => (iso ? stamp.format(new Date(iso)).replace(',', '') : '—');

// Tono de cada resultado (siempre con su texto al lado).
const TONO = Object.freeze({
  factura: 'is-add', gasto: 'is-change', ya_estaba: 'is-neutral', revisar: 'is-warn', a_mano: 'is-add', descartado: 'is-remove',
});

const state = { filters: {}, page: 1, data: null, user: null, els: null, searchTimer: 0 };

function header(backHref) {
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · Correo' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Asistente de correo' }), 1),
      stagger(h('p', { class: 'module-summary', text: 'Lo que hizo solo con el correo de la tienda: qué registró de cada PDF y qué correos marcó como leídos.' }), 2),
    ])),
  ]);
}

function totals() {
  const t = state.data.totales;
  const tile = (label, value, tone = '') => h('div', { class: `asis-tile ${tone}` }, [h('strong', { text: String(value) }), h('span', { text: label })]);
  return h('div', { class: 'asis-tiles' }, [
    tile('correos revisados', t.correos),
    tile('marcados como leídos', t.leidos),
    tile('facturas nuevas', t.facturas, 'is-add'),
    tile('gastos actualizados', t.gastos, 'is-change'),
    tile('para revisar', t.pendientes, t.pendientes ? 'is-warn' : ''),
  ]);
}

function runs() {
  const list = state.data.revisiones;
  if (!list.length) return null;
  const quien = (r) => (r.origen === 'auto' ? 'Diaria' : `A mano${r.usuario ? ` · ${r.usuario}` : ''}`);
  const texto = (r) => {
    if (r.error) return `Error: ${r.error}`;
    if (!r.fin) return 'En curso…';
    return `${r.correos} correos · ${r.facturas} facturas · ${r.gastos} gastos · ${r.leidos ?? 0} leídos · ${r.revisar} para revisar`;
  };
  return h('details', { class: 'asis-runs' }, [
    h('summary', { text: `Últimas revisiones (${list.length})` }),
    h('ul', {}, list.map((r) => h('li', { class: r.error ? 'is-error' : '' }, [
      h('span', { class: 'log-when', text: when(r.inicio) }),
      h('span', { class: 'asis-run-who', text: quien(r) }),
      h('span', { text: texto(r) }),
    ]))),
  ]);
}

function select(name, label, options) {
  const el = h('select', { 'data-filter': name, 'aria-label': label }, [
    h('option', { value: '', text: label }),
    ...options.map(([value, text]) => h('option', { value, text })),
  ]);
  el.value = state.filters[name] ?? '';
  return el;
}

function filterBar() {
  const date = (name, label) => h('label', { class: 'log-date' }, [
    h('span', { text: label }),
    h('input', { type: 'date', 'data-filter': name, value: state.filters[name] ?? '' }),
  ]);
  return h('div', { class: 'filters log-filters' }, [
    select('resultado', 'Todo lo revisado', Object.entries(state.data.filtros)),
    select('leido', 'Leídos y sin leer', [['si', 'Marcados como leídos'], ['no', 'Sin leer']]),
    date('desde', 'Desde'),
    date('hasta', 'Hasta'),
    h('label', { class: 'search search-sm' }, [
      icon('search', 'ico ico-sm'),
      h('span', { class: 'sr-only', text: 'Buscar' }),
      h('input', { type: 'search', placeholder: 'Remitente, asunto, proveedor, nº…', 'data-filter': 'q', value: state.filters.q ?? '', autocomplete: 'off' }),
    ]),
    Object.keys(state.filters).length ? h('button', { class: 'month-today', type: 'button', 'data-clear': '', text: 'Quitar filtros' }) : null,
  ]);
}

/** Lo que registró: la factura (abre su ficha) o el gasto (abre Gastos en ese mes). */
function registro(d) {
  if (d.factura) {
    const f = d.factura;
    return h('button', { type: 'button', class: 'asis-link', 'data-doc': String(f.id) }, [
      h('strong', { text: `${f.tipo === 'pedido' ? 'Pedido' : 'Factura'} ${f.numero}` }),
      h('span', { text: ` · ${f.proveedor}${f.total_cent ? ` · ${formatEuros(f.total_cent)}` : ''}` }),
    ]);
  }
  if (d.gasto) {
    return h('a', { class: 'asis-link', href: `/app/gastos?mes=${d.gasto.mes}`, 'data-nav': '' }, [
      h('strong', { text: d.gasto.nombre ?? 'Gasto' }),
      h('span', { text: ` · ${d.gasto.mes.split('-').reverse().join('/')}` }),
    ]);
  }
  return null;
}

function documento(d) {
  const nombres = state.data.resultados;
  return h('li', { class: 'asis-doc' }, [
    h('span', { class: `log-action ${TONO[d.resultado] ?? 'is-neutral'}`, text: nombres[d.resultado] ?? d.resultado }),
    h('div', { class: 'asis-doc-main' }, [
      h('span', { class: 'asis-file', text: d.archivo }),
      registro(d),
      d.motivo ? h('span', { class: 'asis-why', text: d.faltan_productos ? `${d.motivo} (pendiente)` : d.motivo }) : null,
      d.resuelto_el ? h('span', { class: 'asis-why', text: `Resuelto el ${when(d.resuelto_el)}` }) : null,
    ]),
  ]);
}

function correo(m) {
  return h('article', { class: 'asis-mail' }, [
    h('div', { class: 'asis-mail-head' }, [
      h('div', { class: 'asis-mail-who' }, [
        h('strong', { text: m.asunto || '(sin asunto)' }),
        h('span', { text: `${m.de} · ${when(m.fecha)}` }),
      ]),
      m.leido
        ? h('span', { class: 'asis-read is-read', text: `Leído · ${when(m.leido_el)}` })
        : h('span', { class: 'asis-read', text: 'Sin leer' }),
    ]),
    m.documentos.length
      ? h('ul', { class: 'asis-docs' }, m.documentos.map(documento))
      : h('p', { class: 'asis-why', text: 'Sin PDF: no había nada que registrar.' }),
  ]);
}

function pager() {
  const { page, pageSize, total } = state.data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return h('div', { class: 'log-pager' }, [
    h('span', { class: 'log-count', text: `${from}–${Math.min(total, page * pageSize)} de ${total} correos` }),
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
  const { items } = state.data;
  state.els.body.replaceChildren(
    totals(),
    runs() ?? '',
    filterBar(),
    h('section', { class: 'stat-card is-table asis-list' }, [
      items.length ? h('div', { class: 'asis-mails' }, items.map(correo)) : h('p', { class: 'notice', text: 'No hay correos con estos filtros.' }),
      pager(),
    ]),
  );
  // La búsqueda no pierde el foco al refrescar la lista.
  if (focused === 'q') {
    const input = state.els.body.querySelector('[data-filter="q"]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

async function load() {
  const q = query();
  const res = await api('GET', `/api/correo/historial${q ? `?${q}` : ''}`);
  if (!res.ok) return void state.els.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  // Las revisiones solo llegan en la primera página: se conservan al pasar de página.
  state.data = { ...res.data, revisiones: res.data.page === 1 ? res.data.revisiones : state.data?.revisiones ?? [] };
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
  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-clear]')) {
      state.filters = {};
      state.page = 1;
      load();
      return;
    }
    const doc = event.target.closest('[data-doc]');
    if (doc) {
      if (await openSupplierManager({ docId: Number(doc.dataset.doc), user: state.user })) load();
      return;
    }
    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.page);
      load();
    }
  });
}

/** Pinta Admin › Asistente de correo. Los filtros viajan en la URL. */
export function renderAsistente({ main, user, params, backHref }) {
  state.filters = Object.fromEntries(FILTER_KEYS.filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
  state.page = Math.max(1, Number(params.get('pagina')) || 1);
  state.user = user;
  state.data = null;
  const body = h('div', { class: 'log-body' }, h('p', { class: 'notice', text: 'Cargando el historial…' }));
  const root = h('div', { class: 'recurring log-view' }, [header(backHref), stagger(body, 3)]);
  state.els = { root, body };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Asistente de correo · Puntapié';
  load();
  return root.querySelector('h1');
}
