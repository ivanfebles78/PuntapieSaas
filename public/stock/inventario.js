import { api } from '../api.js';
import { h, stagger } from '../dom.js';
import { icon } from '../icons.js';
import { isReadOnly } from '../modules.js';
import { centToEur, eur, eurToCent } from '../proveedores/util.js';
import { showToast } from '../toast.js';

// Stock › Inventario: existencias por SKU con su código de barras. «Disponible»
// es lo que hay en tienda; «En camino» lo pendiente de recibir (no se vende).

const API = '/api/stock';
const FILTROS = Object.freeze([['todos', 'Todo'], ['disponible', 'Disponible'], ['pendiente', 'En camino'], ['faltas', 'Por reclamar']]);

const state = { user: null, body: null, filtro: 'todos', q: '' };

function header(backHref) {
  return h('header', { class: 'module-head tone-stock users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Stock' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Stock · Existencias' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Inventario' }), 1),
      stagger(h('p', { class: 'module-summary', text: 'Cada talla y color con su código de barras. Lo que está en camino no cuenta como disponible hasta que se recibe.' }), 2),
    ])),
  ]);
}

const uds = (n) => `${n} ${n === 1 ? 'ud.' : 'uds.'}`;
const stat = (label, value, sub, tone) => h('div', { class: `pstat pstat-${tone}` }, [
  h('span', { class: 'pstat-label', text: label }),
  h('span', { class: 'pstat-value', text: value }),
  h('span', { class: 'pstat-sub', text: sub }),
]);

function fila(a, ro) {
  return h('tr', { 'data-id': String(a.id), class: a.stock > 0 ? null : 'is-zero' }, [
    h('td', { class: 'strong', text: a.marca }),
    h('td', { class: 'mono', text: a.referencia }),
    h('td', { text: a.modelo }),
    h('td', { text: a.color }),
    h('td', { class: 'num strong', text: a.talla ? String(a.talla) : '—' }),
    h('td', { class: 'mono small', text: a.codigo }),
    h('td', { class: 'num' }, ro ? eur(a.pvp_cent) : h('input', {
      class: 'pinput num stk-pvp', inputmode: 'decimal', value: centToEur(a.pvp_cent), 'data-pvp': String(a.id), 'aria-label': `PVP de ${a.referencia} talla ${a.talla}`, placeholder: '—',
    })),
    h('td', { class: `num ${a.stock > 0 ? 'strong' : 'pmuted'}`, text: String(a.stock) }),
    h('td', { class: 'num' }, a.pendiente ? h('span', { class: 'sbadge sb-pendiente', text: String(a.pendiente) }) : '—'),
    h('td', { class: 'num' }, a.faltan ? h('span', { class: 'sbadge sb-vencida', text: String(a.faltan) }) : '—'),
    h('td', {}, h('a', { class: 'pbtn pbtn-sm pbtn-ghost', href: `${API}/etiquetas.pdf?articulo=${a.id}&copias=1&ver=1`, target: '_blank', rel: 'noopener', title: 'Imprimir una etiqueta', text: 'Etiqueta' })),
  ]);
}

async function cargar() {
  const tabla = state.body.querySelector('[data-tabla]');
  const stats = state.body.querySelector('[data-stats]');
  const query = new URLSearchParams({ estado: state.filtro, ...(state.q ? { q: state.q } : {}) });
  const res = await api('GET', `${API}/inventario?${query}`);
  if (!res.ok) return void tabla.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const { articulos, resumen: r } = res.data;
  stats.replaceChildren(
    stat('Disponible', uds(r.disponible), `${r.articulos} tallas con stock`, 'ok'),
    stat('En camino', uds(r.pendiente), 'pendientes de recibir', 'warn'),
    stat('Por reclamar', uds(r.faltan), 'no llegaron con su pedido', 'vencido'),
  );
  const ro = isReadOnly(state.user);
  tabla.replaceChildren(articulos.length
    ? h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable stk-table' }, [
      h('thead', {}, h('tr', {}, ['Marca', 'Ref.', 'Modelo', 'Color', 'Talla', 'Código', 'PVP €', 'Disponible', 'En camino', 'Faltan', '']
        .map((t, i) => h('th', { scope: 'col', class: [4, 6, 7, 8, 9].includes(i) ? 'num' : null, text: t })))),
      h('tbody', {}, articulos.map((a) => fila(a, ro))),
    ]))
    : h('div', { class: 'pempty' }, [h('h3', { text: 'No hay artículos que mostrar' }), h('p', { text: 'Se dan de alta al importar el PDF de un pedido o factura con sus productos.' })]));
  return undefined;
}

function bind(root) {
  root.addEventListener('click', (ev) => {
    const f = ev.target.closest('[data-filtro]');
    if (!f) return;
    state.filtro = f.dataset.filtro;
    root.querySelectorAll('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b === f)));
    cargar();
  });
  root.addEventListener('change', async (ev) => {
    if (ev.target.matches('[data-buscar]')) { state.q = ev.target.value.trim(); return void cargar(); }
    const pvp = ev.target.closest('[data-pvp]');
    if (!pvp) return undefined;
    const cent = pvp.value.trim() ? eurToCent(pvp.value) : null;
    if (pvp.value.trim() && cent == null) return void showToast('Escribe el PVP como 39,95.', { tone: 'error' });
    const res = await api('PUT', `${API}/articulos/${pvp.dataset.pvp}`, { pvp_cent: cent });
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    pvp.value = centToEur(res.data.pvp_cent);
    return void showToast('PVP guardado.');
  });
}

/** Pinta Stock › Inventario. */
export function renderInventario({ main, user, backHref }) {
  state.user = user;
  state.body = h('div', { class: 'stk-body' }, [
    h('div', { class: 'pstats', 'data-stats': '' }),
    h('div', { class: 'ptoolbar stk-toolbar' }, [
      h('input', { type: 'search', class: 'pinput grow', placeholder: 'Buscar por marca, referencia, modelo, color o código…', value: state.q, 'data-buscar': '' }),
      h('div', { class: 'pchips', role: 'group', 'aria-label': 'Filtro' }, FILTROS.map(([v, t]) => h('button', {
        type: 'button', class: 'pchip', 'aria-pressed': String(state.filtro === v), 'data-filtro': v, text: t,
      }))),
    ]),
    h('div', { 'data-tabla': '' }, h('p', { class: 'notice', text: 'Cargando…' })),
  ]);
  const root = h('div', { class: 'recurring stk-view' }, [header(backHref), stagger(state.body, 2)]);
  bind(root);
  main.replaceChildren(root);
  document.title = 'Inventario · Puntapié';
  cargar();
  return root.querySelector('h1');
}
