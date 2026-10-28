import { api } from '../api.js';
import { h, stagger } from '../dom.js';
import { icon } from '../icons.js';
import { isReadOnly } from '../modules.js';
import { openSupplierManager } from '../proveedores/manager.js';
import { badge, fecha } from '../proveedores/util.js';
import { showToast } from '../toast.js';

// Stock › Recepción: la mercancía de los pedidos y facturas importados. Al
// llegar a la tienda se imprimen las etiquetas, se marca lo que falta (si
// falta algo) y con un clic lo recibido pasa a stock disponible.

const BASE_PATH = '/app/stock/recepcion';
const API = '/api/stock';
const FILTROS = Object.freeze([['pendientes', 'Por recibir'], ['faltas', 'Por reclamar'], ['todas', 'Todas']]);
const ESTADOS = Object.freeze({ pendiente: ['Pendiente', 'sb-pendiente'], recibido: ['Recibido', 'sb-pagada'], falta: ['Falta', 'sb-vencida'], anulado: ['Anulado', 'sb-cancelado'] });

const state = { user: null, root: null, body: null, filtro: 'pendientes', faltan: new Map() };
const ro = () => isReadOnly(state.user);
const uds = (n) => `${n} ${n === 1 ? 'unidad' : 'unidades'}`;
const etiquetasHref = (docId, lineas) => `${API}/etiquetas.pdf?doc=${docId}${lineas ? `&lineas=${lineas}` : ''}&ver=1`;

function header(backHref) {
  return h('header', { class: 'module-head tone-stock users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Stock' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Stock · Mercancía en camino' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Recepción' }), 1),
      stagger(h('p', { class: 'module-summary', text: 'Imprime las etiquetas, pégalas en las cajas y marca solo lo que falte: lo recibido pasa a stock con un clic.' }), 2),
    ])),
  ]);
}

const estadoBadge = (estado) => h('span', { class: `sbadge ${ESTADOS[estado][1]}`, text: ESTADOS[estado][0] });

/* ---------- Lista ---------- */

function tarjetaEntrada(e) {
  const t = e.totales;
  return h('button', { class: 'stk-entry', type: 'button', 'data-doc': String(e.id) }, [
    h('span', { class: 'stk-entry-main' }, [
      h('strong', { text: e.proveedor }),
      h('span', { class: 'pmuted small' }, [badge(e.tipo), ` ${e.numero} · ${e.fecha_entrega ? `entrega ${fecha(e.fecha_entrega)}` : `del ${fecha(e.fecha)}`}`]),
    ]),
    h('span', { class: 'stk-entry-nums' }, [
      t.pendientes ? h('span', { class: 'sbadge sb-pendiente', text: `${t.pendientes} por recibir` }) : null,
      t.faltan ? h('span', { class: 'sbadge sb-vencida', text: `${t.faltan} faltan` }) : null,
      !t.pendientes && !t.faltan ? h('span', { class: 'sbadge sb-pagada', text: 'Recibido' }) : null,
      h('span', { class: 'pmuted small', text: `${t.unidades} uds.` }),
    ]),
  ]);
}

async function pintarLista() {
  state.body.replaceChildren(h('p', { class: 'notice', text: 'Cargando…' }));
  const res = await api('GET', `${API}/entradas?estado=${state.filtro}`);
  if (!res.ok) return void state.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const vacio = { pendientes: 'No hay mercancía pendiente de recibir.', faltas: 'No hay nada pendiente de reclamar.', todas: 'Todavía no hay pedidos con productos.' }[state.filtro];
  state.body.replaceChildren(
    h('div', { class: 'ptoolbar stk-toolbar' }, [
      h('div', { class: 'pchips', role: 'group', 'aria-label': 'Filtro' }, FILTROS.map(([v, t]) => h('button', {
        type: 'button', class: 'pchip', 'aria-pressed': String(state.filtro === v), 'data-filtro': v, text: t,
      }))),
      ro() ? null : h('button', { class: 'pbtn pbtn-primary', type: 'button', 'data-importar': '', text: '＋ Importar pedido o factura' }),
    ]),
    res.data.length
      ? h('div', { class: 'stk-entries' }, res.data.map(tarjetaEntrada))
      : h('div', { class: 'pempty' }, [h('h3', { text: vacio }), h('p', { text: 'Los productos se dan de alta al importar el PDF del pedido (o de la factura) en Gastos › Pagos a proveedores.' })]),
  );
  return undefined;
}

/* ---------- Detalle de una entrada ---------- */

function celdaFalta(l) {
  if (l.estado !== 'pendiente' || ro()) return null;
  const falta = state.faltan.get(l.id) ?? 0;
  if (!falta) return h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-falta': String(l.id), text: 'Falta' });
  return h('span', { class: 'stk-falta' }, [
    h('label', {}, [
      h('span', { class: 'sr-only', text: 'Unidades que faltan' }),
      h('input', { type: 'number', class: 'pinput num', min: '1', max: String(l.cantidad), value: String(falta), 'data-falta-n': String(l.id), 'aria-label': 'Unidades que faltan' }),
    ]),
    h('span', { class: 'small', text: `de ${l.cantidad}` }),
    h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-llega': String(l.id), title: 'Sí ha llegado', text: '✕' }),
  ]);
}

function accionesFalta(l) {
  if (l.estado !== 'falta' || ro()) return null;
  return h('span', { class: 'pbtn-row' }, [
    h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-resolver': 'llegado', 'data-linea': String(l.id), text: `Han llegado ${l.faltan}` }),
    h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-resolver': 'anular', 'data-linea': String(l.id), text: 'No llegará' }),
  ]);
}

function filaLinea(l, docId) {
  const a = l.articulo;
  const marcada = state.faltan.get(l.id);
  return h('tr', { class: marcada ? 'is-falta' : l.estado === 'falta' ? 'is-reclamar' : null }, [
    h('td', { class: 'mono', text: a.referencia }),
    h('td', { text: a.modelo }),
    h('td', { text: a.color }),
    h('td', { class: 'num strong', text: a.talla ? String(a.talla) : '—' }),
    h('td', { class: 'num', text: l.estado === 'falta' ? `${l.recibidas} de ${l.cantidad}` : String(l.cantidad) }),
    h('td', { class: 'mono small' }, h('a', { href: etiquetasHref(docId, l.id), target: '_blank', rel: 'noopener', title: 'Reimprimir las etiquetas de esta línea', text: a.codigo })),
    h('td', {}, estadoBadge(l.estado)),
    h('td', {}, celdaFalta(l) ?? accionesFalta(l)),
  ]);
}

function resumenRecepcion(e) {
  const pendientes = e.lineas.filter((l) => l.estado === 'pendiente');
  const total = pendientes.reduce((s, l) => s + l.cantidad, 0);
  const faltan = pendientes.reduce((s, l) => s + (state.faltan.get(l.id) ?? 0), 0);
  return { total, faltan, llegan: total - faltan };
}

async function pintarEntrada(docId) {
  state.body.replaceChildren(h('p', { class: 'notice', text: 'Cargando…' }));
  const res = await api('GET', `${API}/entradas/${docId}`);
  if (!res.ok) return void state.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const e = res.data;
  const d = e.documento;
  const t = e.totales;
  const r = resumenRecepcion(e);
  const anuladas = e.lineas.filter((l) => l.estado === 'anulado').reduce((s, l) => s + l.cantidad, 0);
  state.body.replaceChildren(
    h('div', { class: 'stk-detail' }, [
      h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-volver': '', text: '← Todas las entradas' }),
      h('div', { class: 'phead' }, [
        h('div', {}, [
          h('h3', {}, [d.proveedor.nombre, ' ', badge(d.tipo), ` ${d.numero}`]),
          h('p', { text: [`${t.unidades} unidades en ${t.lineas} líneas`, d.fecha_entrega ? `entrega prevista ${fecha(d.fecha_entrega)}` : null,
            t.recibidas ? `${t.recibidas} recibidas` : null, t.faltan ? `${t.faltan} por reclamar` : null].filter(Boolean).join(' · ') }),
        ]),
        h('div', { class: 'pbtn-row' }, [
          h('a', { class: 'pbtn pbtn-primary', href: etiquetasHref(d.id), target: '_blank', rel: 'noopener' }, [`Imprimir etiquetas (${t.unidades - anuladas})`]),
        ]),
      ]),
      t.pendientes && !ro() ? h('div', { class: 'stk-confirm' }, [
        h('p', {}, r.faltan
          ? [h('strong', { text: `Llegan ${r.llegan} de ${r.total}` }), ` · ${r.faltan} marcadas como falta quedarán para reclamar.`]
          : [h('strong', { text: `Llegan las ${r.total} unidades` }), ' · si falta algo, pulsa «Falta» en su línea antes de confirmar.']),
        h('button', { class: 'pbtn pbtn-primary', type: 'button', 'data-recibir': String(d.id), text: r.faltan ? `Confirmar recepción (${r.llegan} a stock)` : 'Todo recibido: pasar a stock' }),
      ]) : null,
      h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable stk-table' }, [
        h('thead', {}, h('tr', {}, ['Ref.', 'Modelo', 'Color', 'Talla', 'Uds.', 'Código', 'Estado', ''].map((x, i) => h('th', { scope: 'col', class: i === 3 || i === 4 ? 'num' : null, text: x })))),
        h('tbody', {}, e.lineas.map((l) => filaLinea(l, d.id))),
      ])),
    ]),
  );
  state.docId = d.id;
  state.entrada = e;
  return undefined;
}

function irA(docId) {
  state.faltan = new Map();
  history.replaceState(history.state, '', docId ? `${BASE_PATH}?doc=${docId}` : BASE_PATH);
  return docId ? pintarEntrada(docId) : pintarLista();
}

async function recibir(docId) {
  const faltan = Object.fromEntries(state.faltan);
  const res = await api('POST', `${API}/entradas/${docId}/recibir`, { faltan });
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  showToast(res.data.faltan
    ? `${uds(res.data.recibidas)} a stock; ${uds(res.data.faltan)} para reclamar.`
    : `${uds(res.data.recibidas)} a stock.`);
  return void irA(docId);
}

function bind(root) {
  root.addEventListener('click', async (ev) => {
    const t = ev.target;
    const filtro = t.closest('[data-filtro]');
    if (filtro) { state.filtro = filtro.dataset.filtro; return void pintarLista(); }
    if (t.closest('[data-importar]')) return void openSupplierManager({ view: 'importar', user: state.user });
    const doc = t.closest('[data-doc]');
    if (doc) return void irA(Number(doc.dataset.doc));
    if (t.closest('[data-volver]')) return void irA(null);
    const falta = t.closest('[data-falta]');
    if (falta) {
      const l = state.entrada.lineas.find((x) => x.id === Number(falta.dataset.falta));
      state.faltan.set(l.id, l.cantidad);
      return void repintar();
    }
    const llega = t.closest('[data-llega]');
    if (llega) { state.faltan.delete(Number(llega.dataset.llega)); return void repintar(); }
    const recibirBtn = t.closest('[data-recibir]');
    if (recibirBtn) return void recibir(Number(recibirBtn.dataset.recibir));
    const resolver = t.closest('[data-resolver]');
    if (resolver) {
      const res = await api('POST', `${API}/lineas/${resolver.dataset.linea}/${resolver.dataset.resolver}`);
      if (!res.ok) return void showToast(res.error, { tone: 'error' });
      showToast(resolver.dataset.resolver === 'llegado' ? 'Recibido: pasa a stock.' : 'Anulado: ya no se espera.');
      return void irA(state.docId);
    }
    return undefined;
  });
  root.addEventListener('change', (ev) => {
    const n = ev.target.closest('[data-falta-n]');
    if (!n) return;
    const id = Number(n.dataset.faltaN);
    const l = state.entrada.lineas.find((x) => x.id === id);
    const v = Math.min(l.cantidad, Math.max(0, Math.round(Number(n.value) || 0)));
    if (v) state.faltan.set(id, v); else state.faltan.delete(id);
    repintar();
  });
}

/** Repinta el detalle conservando lo marcado (sin volver a pedirlo al servidor). */
function repintar() {
  const scroll = window.scrollY;
  pintarEntradaLocal(state.entrada);
  window.scrollTo({ top: scroll });
}

function pintarEntradaLocal(e) {
  const tbody = state.body.querySelector('.stk-table tbody');
  if (!tbody) return;
  tbody.replaceChildren(...e.lineas.map((l) => filaLinea(l, e.documento.id)));
  const confirm = state.body.querySelector('.stk-confirm');
  if (!confirm) return;
  const r = resumenRecepcion(e);
  confirm.querySelector('p').replaceChildren(...(r.faltan
    ? [h('strong', { text: `Llegan ${r.llegan} de ${r.total}` }), ` · ${r.faltan} marcadas como falta quedarán para reclamar.`]
    : [h('strong', { text: `Llegan las ${r.total} unidades` }), ' · si falta algo, pulsa «Falta» en su línea antes de confirmar.']));
  confirm.querySelector('[data-recibir]').textContent = r.faltan ? `Confirmar recepción (${r.llegan} a stock)` : 'Todo recibido: pasar a stock';
}

/** Pinta Stock › Recepción. Admite ?doc=ID y ?accion=importar. */
export function renderRecepcion({ main, user, params, backHref }) {
  state.user = user;
  state.faltan = new Map();
  state.body = h('div', { class: 'stk-body' });
  state.root = h('div', { class: 'recurring stk-view' }, [header(backHref), stagger(state.body, 2)]);
  bind(state.root);
  main.replaceChildren(state.root);
  document.title = 'Recepción · Puntapié';
  const doc = Number(params.get('doc'));
  if (Number.isInteger(doc) && doc > 0) pintarEntrada(doc); else pintarLista();
  if (params.get('accion') === 'importar' && !isReadOnly(user)) openSupplierManager({ view: 'importar', user });
  return state.root.querySelector('h1');
}
