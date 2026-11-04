import { api } from '../api.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { showToast } from '../toast.js';
import { renderAprobar } from './aprobar.js';
import { cajaAbierta, renderCaja } from './caja.js';
import { renderCambio } from './cambio.js';
import { renderGarantias } from './garantias.js';
import { renderReservas } from './reservas.js';
import { renderVenta } from './venta.js';

// Ventas › TPV: pantalla de inicio a pantalla completa, pensada para la
// pantalla táctil de la caja. Por ahora solo los botones de cada sección
// (su contenido llegará después) y el resumen de hoy de la Caja diaria.

const BACK_HREF = '/app/ventas';
const TICK_MS = 15_000;
const TZ = 'Atlantic/Canary';

// Iconos de trazo (Lucide, licencia ISC), en una rejilla de 24×24.
const ICONS = Object.freeze({
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  percent: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><path d="M9 9h.01"/><path d="M15 15h.01"/>',
  box: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  register: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings: '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"/>',
});

function ico(name, cls = 'tpv-ico') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return t.content.firstElementChild;
}

// Las secciones del TPV, en el orden de la pantalla (3 × 3).
const SECCIONES = Object.freeze([
  { id: 'venta', nombre: 'Venta rápida', detalle: 'Cobrar productos', icono: 'cart', tono: 'coral' },
  { id: 'cambios', nombre: 'Cambios y devoluciones', detalle: 'Por otro producto o un vale', icono: 'swap', tono: 'sky' },
  { id: 'promociones', nombre: 'Promociones y descuentos', icono: 'percent', tono: 'sand' },
  { id: 'inventario', nombre: 'Inventario', detalle: 'Stock, tallas y modelos', icono: 'box', tono: 'mint' },
  { id: 'compras', nombre: 'Compras y proveedores', icono: 'truck', tono: 'lilac' },
  { id: 'clientes', nombre: 'Clientes', detalle: 'Fidelización y vales', icono: 'users', tono: 'blue' },
  { id: 'informes', nombre: 'Informes', detalle: 'Ventas, productos y rentabilidad', icono: 'chart', tono: 'violet' },
  { id: 'gastos', nombre: 'Gastos', detalle: 'Control de costes', icono: 'coins', tono: 'peach' },
  { id: 'reservas', nombre: 'Reservas', detalle: 'Apartar sin pagar', icono: 'calendar', tono: 'stone' },
]);

const NAV = Object.freeze([['inicio', 'Inicio', 'home'], ['caja', 'Caja', 'register'], ['consultas', 'Consultas', 'search'], ['ajustes', 'Ajustes', 'settings']]);

const hora = () => new Intl.DateTimeFormat('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date());
const fechaCorta = () => new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())
  .replace(/^\w/, (c) => c.toUpperCase()).replace(/\./g, '');

const proximamente = (nombre) => showToast(`${nombre}: próximamente.`);

/** La huella del logo de Puntapié (la misma que la cabecera de la app). */
function huella() {
  const t = document.createElement('template');
  t.innerHTML = '<svg class="tpv-foot-mark" viewBox="0 0 64 84" aria-hidden="true" focusable="false"><ellipse cx="34" cy="54" rx="21" ry="29"/><circle cx="14" cy="19" r="8"/><circle cx="27" cy="11" r="6.4"/><circle cx="39" cy="9" r="5.6"/><circle cx="50" cy="12" r="4.8"/><circle cx="58" cy="19" r="4"/></svg>';
  return t.content.firstElementChild;
}

function cabecera() {
  const reloj = h('div', { class: 'tpv-clock', 'aria-live': 'off' }, [h('strong', { 'data-hora': '', text: hora() }), h('span', { 'data-fecha': '', text: fechaCorta() })]);
  return h('header', { class: 'tpv-bar' }, [
    h('div', { class: 'tpv-brand' }, [
      huella(),
      h('span', { class: 'tpv-brand-text' }, [h('strong', { text: 'Puntapié' }), h('small', { text: 'Zapatería infantil' })]),
    ]),
    h('nav', { class: 'tpv-nav', 'aria-label': 'TPV' }, NAV.map(([id, nombre, icono]) => h('button', {
      class: 'tpv-nav-btn', type: 'button', 'data-nav-tpv': id, 'aria-current': id === 'inicio' ? 'page' : null,
    }, [ico(icono, 'tpv-ico tpv-ico-nav'), h('span', { text: nombre })]))),
    h('div', { class: 'tpv-status', 'data-caja': '' }, [h('span', { class: 'tpv-dot' }), h('span', { 'data-caja-texto': '', text: 'Caja de hoy…' })]),
    reloj,
  ]);
}

function boton(s) {
  return h('button', { class: `tpv-tile tone-${s.tono}`, type: 'button', 'data-seccion': s.id }, [
    ico(s.icono, 'tpv-ico tpv-ico-tile'),
    h('span', { class: 'tpv-tile-name', text: s.nombre }),
    s.detalle ? h('span', { class: 'tpv-tile-detail', 'data-detalle': s.id, text: s.detalle }) : null,
  ]);
}

function filaResumen(icono, etiqueta, clave) {
  return h('li', {}, [ico(icono, 'tpv-ico tpv-ico-row'), h('span', { text: etiqueta }), h('strong', { 'data-resumen': clave, text: '—' })]);
}

function panel() {
  return h('aside', { class: 'tpv-side' }, [
    h('section', { class: 'tpv-card' }, [
      h('h2', {}, [ico('chart', 'tpv-ico tpv-ico-row'), 'Hoy en la tienda']),
      h('ul', { class: 'tpv-today' }, [filaResumen('tag', 'Ventas', 'ventas'), filaResumen('users', 'Clientes', 'clientes')]),
      h('p', { class: 'tpv-note', text: 'Ventas del TPV de hoy (sin contar lo cobrado con vales).' }),
    ]),
    h('section', { class: 'tpv-card' }, [
      h('h2', { text: 'Mis aplicaciones' }),
      h('a', { class: 'tpv-app', href: 'https://zapateriapuntapie.com', target: '_blank', rel: 'noopener' }, [
        ico('monitor', 'tpv-ico tpv-ico-app'), h('span', { text: 'Tienda online' }), ico('external', 'tpv-ico tpv-ico-ext'),
      ]),
      h('button', { class: 'tpv-app', type: 'button', 'data-app': 'Gestión externa' }, [
        ico('cloud', 'tpv-ico tpv-ico-app'), h('span', {}, [h('strong', { text: 'Gestión externa' }), h('small', { text: 'Contabilidad · Nóminas · etc' })]), ico('external', 'tpv-ico tpv-ico-ext'),
      ]),
    ]),
  ]);
}

function pie(user) {
  return h('footer', { class: 'tpv-foot' }, [
    h('div', { class: 'tpv-user' }, [h('span', { class: 'tpv-avatar', text: (user.name ?? '?').charAt(0).toUpperCase() }), h('strong', { text: user.name ?? '' })]),
    h('div', { class: 'tpv-foot-actions' }, [
      h('a', { class: 'tpv-ghost', href: BACK_HREF, 'data-nav': '' }, [ico('back', 'tpv-ico tpv-ico-row'), 'Volver a la gestión']),
      h('button', { class: 'tpv-ghost', type: 'button', 'data-cerrar-caja': '' }, [ico('power', 'tpv-ico tpv-ico-row'), 'Cerrar caja']),
    ]),
  ]);
}

/** Estado de la caja (arriba) y lo vendido hoy en el TPV (panel del inicio). */
async function cargarHoy(root) {
  const res = await api('GET', '/api/tpv/hoy');
  const texto = root.querySelector('[data-caja-texto]');
  const estado = root.querySelector('[data-caja]');
  if (!res.ok) {
    texto.textContent = 'Caja sin datos';
    return;
  }
  const d = res.data;
  estado.classList.toggle('is-on', d.caja.abierta);
  texto.textContent = d.caja.abierta
    ? `Caja abierta · ${new Intl.DateTimeFormat('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(d.caja.desde))}`
    : 'Caja cerrada';
  const reservas = root.querySelector('[data-detalle=reservas]');
  if (reservas && d.reservas?.activas) {
    const { activas, vencen_hoy: hoy } = d.reservas;
    reservas.textContent = `${activas} ${activas === 1 ? 'activa' : 'activas'}${hoy ? ` · ${hoy} ${hoy === 1 ? 'vence' : 'vencen'} hoy` : ''}`;
    reservas.closest('[data-seccion]').classList.toggle('is-aviso', hoy > 0);
  }
  const ventas = root.querySelector('[data-resumen=ventas]');
  if (!ventas) return; // ya se ha salido del inicio (p. ej. a la venta)
  ventas.textContent = formatEuros(d.ventas_cent);
  root.querySelector('[data-resumen=clientes]').textContent = String(d.tickets);
}

const TPV_PATH = '/app/ventas/tpv';

/** Pinta Ventas › TPV a pantalla completa (?seccion=venta abre la venta; ?aprobar= el enlace del WhatsApp). */
export function renderTpv({ main, user, params }) {
  const cuerpo = h('div', { class: 'tpv-body' });
  const root = h('div', { class: 'tpv', role: 'application', 'aria-label': 'TPV Puntapié' }, [cabecera(), cuerpo, pie(user)]);

  function inicio({ push = false } = {}) {
    if (push) history.pushState({ app: true }, '', TPV_PATH);
    cuerpo.classList.remove('is-venta');
    cuerpo.replaceChildren(
      h('h1', { class: 'sr-only', tabindex: '-1', text: 'TPV' }),
      h('div', { class: 'tpv-grid' }, SECCIONES.map(boton)),
      panel(),
    );
    cargarHoy(root);
  }
  const salir = () => inicio({ push: true });
  // Para vender, la caja tiene que estar abierta: si no, primero se abre (con el recuento).
  // Con `reserva`, la venta empieza con sus productos y al cobrarla queda vendida.
  async function abrirVenta({ push = false, reserva = null } = {}) {
    if (push) history.pushState({ app: true }, '', `${TPV_PATH}?seccion=venta`);
    cuerpo.classList.add('is-venta');
    const vender = () => renderVenta(cuerpo, { user, salir, reserva });
    if (await cajaAbierta()) return void vender();
    return void renderCaja(cuerpo, { user, salir, irVenta: vender, alAbrir: vender });
  }
  async function abrirCambios({ push = false } = {}) {
    if (push) history.pushState({ app: true }, '', `${TPV_PATH}?seccion=cambios`);
    cuerpo.classList.add('is-venta');
    const cambiar = () => renderCambio(cuerpo, { user, salir, irGarantias: () => abrirGarantias({ push: true }) });
    if (await cajaAbierta()) return void cambiar();
    return void renderCaja(cuerpo, { user, salir, irVenta: cambiar, alAbrir: cambiar });
  }
  // Garantías: lo devuelto como defectuoso (no hace falta la caja abierta).
  function abrirGarantias({ push = false } = {}) {
    if (push) history.pushState({ app: true }, '', `${TPV_PATH}?seccion=garantias`);
    cuerpo.classList.add('is-venta');
    renderGarantias(cuerpo, { user, salir, volverCambios: () => abrirCambios({ push: true }) });
  }
  // Reservas: apartar productos sin pagar (no hace falta la caja abierta; para venderlas, sí).
  function abrirReservas({ push = false } = {}) {
    if (push) history.pushState({ app: true }, '', `${TPV_PATH}?seccion=reservas`);
    cuerpo.classList.add('is-venta');
    renderReservas(cuerpo, { user, salir, vender: (reserva) => abrirVenta({ push: true, reserva }) });
  }
  function abrirCaja({ push = false, modo = 'resumen' } = {}) {
    if (push) history.pushState({ app: true }, '', `${TPV_PATH}?seccion=caja`);
    cuerpo.classList.add('is-venta');
    renderCaja(cuerpo, { user, salir, irVenta: () => abrirVenta({ push: true }), modo });
  }

  root.addEventListener('click', (e) => {
    const s = e.target.closest('[data-seccion]');
    if (s?.dataset.seccion === 'venta') return void abrirVenta({ push: true });
    if (s?.dataset.seccion === 'cambios') return void abrirCambios({ push: true });
    if (s?.dataset.seccion === 'reservas') return void abrirReservas({ push: true });
    if (s) return void proximamente(SECCIONES.find((x) => x.id === s.dataset.seccion).nombre);
    const n = e.target.closest('[data-nav-tpv]');
    if (n?.dataset.navTpv === 'inicio') return void inicio({ push: true });
    if (n?.dataset.navTpv === 'caja') return void abrirCaja({ push: true });
    if (n) return void proximamente(n.textContent);
    const app = e.target.closest('[data-app]');
    if (app) return void proximamente(app.dataset.app);
    if (e.target.closest('[data-cerrar-caja]')) return void abrirCaja({ push: true, modo: 'cierre' });
    return undefined;
  });
  main.replaceChildren(root);
  document.title = 'TPV · Puntapié';
  const aprobar = params?.get('aprobar');
  if (aprobar) {
    cuerpo.classList.add('is-venta');
    renderAprobar(cuerpo, { token: aprobar, user });
  } else if (params?.get('seccion') === 'venta') abrirVenta();
  else if (params?.get('seccion') === 'caja') abrirCaja();
  else if (params?.get('seccion') === 'cambios') abrirCambios();
  else if (params?.get('seccion') === 'garantias') abrirGarantias();
  else if (params?.get('seccion') === 'reservas') abrirReservas();
  else inicio();
  if (aprobar || params?.get('seccion')) cargarHoy(root);
  // El reloj se actualiza mientras la pantalla siga abierta.
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    root.querySelector('[data-hora]').textContent = hora();
    root.querySelector('[data-fecha]').textContent = fechaCorta();
    cargarHoy(root); // estado de la caja arriba (abierta/cerrada) y ventas de hoy
  }, TICK_MS);
  return root.querySelector('h1') ?? root;
}
