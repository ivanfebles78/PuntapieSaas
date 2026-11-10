import { api } from './api.js';
import { h, stagger } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

// Admin › Sistema antiguo: mientras se siga usando gestiondegastos, el
// programa se trae cada día lo que falte (caja, gastos diarios y mensuales, y
// los PDF de los gastos). Aquí se ve cómo fue y se decide lo que no es obvio.

const BASE_PATH = '/app/admin/antiguo';
const VISTAS = Object.freeze([
  { id: 'cambios', label: 'Cambios', vacio: 'No hay nada que haya cambiado en el antiguo después de traerlo.' },
  { id: 'revisar', label: 'Archivos por asignar', vacio: 'No queda ningún PDF por asignar.' },
  { id: 'traidos', label: 'Traído', vacio: 'Todavía no se ha traído nada.' },
  { id: 'ignorados', label: 'Ignorado y respetado', vacio: 'No hay nada ignorado.' },
]);
const ORIGEN = Object.freeze({ dia: 'Caja', gasto: 'Gasto diario', mensual: 'Gasto mensual', adjunto: 'PDF' });
const stamp = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Atlantic/Canary', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const when = (iso) => (iso ? stamp.format(new Date(iso)).replace(',', '') : '—');
const fechaEs = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

const state = { vista: 'cambios', estado: null, items: [], els: null, ocupado: false };

function header(backHref) {
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · gestiondegastos' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Sistema antiguo' }), 1),
      stagger(h('p', {
        class: 'module-summary',
        text: 'Lo que se apunta en gestiondegastos llega solo: días de caja, gastos diarios y mensuales y sus PDF. Lo que ya está aquí no se pisa.',
      }), 2),
    ])),
  ]);
}

function resumenUltima(u) {
  if (!u) return 'Todavía no se ha sincronizado nunca.';
  const quien = u.origen === 'auto' ? 'Automática' : `A mano${u.usuario ? ` · ${u.usuario}` : ''}`;
  if (u.error) return `${quien}, ${when(u.inicio)}: falló — ${u.error}`;
  if (!u.fin) return `${quien}, ${when(u.inicio)}: en curso…`;
  const r = u.resumen ?? {};
  const n = (v, uno, varios) => `${v ?? 0} ${v === 1 ? uno : varios}`;
  const partes = [n(r.dias, 'día', 'días'), n(r.gastos, 'gasto', 'gastos'), n(r.mensuales, 'mensual', 'mensuales'), `${r.adjuntos ?? 0} PDF`];
  const errores = r.errores?.length ? ` · ${r.errores.length} con error` : '';
  return `${quien}, ${when(u.inicio)}: trajo ${partes.join(', ')}${errores}.`;
}

function panelEstado() {
  const e = state.estado;
  const boton = h('button', { class: 'btn-chip ant-sync', type: 'button', 'data-write': '', 'data-sync': '', disabled: !e.configurado || state.ocupado, 'aria-busy': state.ocupado ? 'true' : null }, [
    icon('repeat', 'ico ico-sm'), h('span', { text: state.ocupado ? 'Sincronizando…' : 'Sincronizar ahora' }),
  ]);
  const texto = e.configurado
    ? `Conectado a gestiondegastos. Se sincroniza solo cada día a partir de las ${e.hora}:00.`
    : 'Sin conectar: añade GESTIONGASTOS_USUARIO y GESTIONGASTOS_CLAVE en Railway (las de tu usuario de gestiondegastos).';
  return h('section', { class: `stat-card ant-estado${e.ultima?.error ? ' is-error' : ''}` }, [
    h('div', {}, [
      h('p', { class: 'ant-estado-main', text: texto }),
      h('p', { class: 'ant-estado-last', text: resumenUltima(e.ultima) }),
    ]),
    boton,
  ]);
}

function tiles() {
  const c = state.estado.contadores;
  const tile = (label, value, tone = '') => h('div', { class: `asis-tile ${tone}` }, [h('strong', { text: String(value) }), h('span', { text: label })]);
  return h('div', { class: 'asis-tiles' }, [
    tile('cambios por decidir', c.cambios, c.cambios ? 'is-warn' : ''),
    tile('PDF por asignar', c.revisar, c.revisar ? 'is-warn' : ''),
    tile('traídos', c.traidos, 'is-add'),
    tile('ignorados o respetados', c.ignorados),
  ]);
}

function pestanas() {
  const c = state.estado.contadores;
  const n = { cambios: c.cambios, revisar: c.revisar };
  return h('div', { class: 'segmented ant-tabs', role: 'group', 'aria-label': 'Qué ver' }, VISTAS.map((v) => h('button', {
    type: 'button', 'data-vista': v.id, 'aria-pressed': String(state.vista === v.id),
    text: n[v.id] ? `${v.label} (${n[v.id]})` : v.label,
  })));
}

const accion = (id, nombre, label, extra = '') => h('button', {
  class: `btn-text ant-act${extra}`, type: 'button', 'data-write': '', 'data-item': String(id), 'data-accion': nombre, text: label,
});

function asignador(item) {
  const gasto = h('select', { 'data-gasto': '', 'aria-label': `Gasto al que va ${item.titulo}` }, [
    h('option', { value: '', text: 'Elige el gasto…' }),
    ...item.gastos.map((g) => h('option', {
      value: String(g.id), text: `${g.mismo_dia ? '● ' : ''}${g.nombre} · ${g.importe}${g.fecha ? ` · ${fechaEs(g.fecha)}` : ''}`,
    })),
    h('option', { value: 'nuevo', text: 'Otros: factura de otro comercio (gasto nuevo)' }),
  ]);
  // «Otros»: se crea un gasto esporádico de ese día con el comercio y el importe.
  const nuevo = h('div', { class: 'ant-new', 'data-nuevo': '', hidden: true }, [
    h('input', { type: 'text', 'data-concepto': '', maxlength: '80', placeholder: 'Comercio o concepto', 'aria-label': 'Comercio o concepto del gasto nuevo' }),
    h('input', { type: 'text', 'data-importe': '', inputmode: 'decimal', placeholder: 'Importe €', 'aria-label': 'Importe del gasto nuevo' }),
  ]);
  const tipo = h('select', { 'data-tipo': '', 'aria-label': 'Qué es el archivo' }, [
    h('option', { value: 'factura', text: 'Factura' }),
    h('option', { value: 'justificante', text: 'Justificante de pago' }),
  ]);
  return h('div', { class: 'ant-assign', 'data-write': '' }, [
    h('a', { class: 'btn-text', href: `/api/antiguo/items/${item.id}/archivo`, target: '_blank', rel: 'noopener', text: 'Ver PDF' }),
    gasto, nuevo, tipo,
    h('button', { class: 'btn-chip ant-assign-go', type: 'button', 'data-item': String(item.id), 'data-accion': 'asignar', text: 'Asignar' }),
    accion(item.id, 'ignorar', 'Ignorar'),
  ]);
}

function acciones(item) {
  if (item.estado === 'cambio') {
    return h('div', { class: 'ant-actions' }, [
      accion(item.id, 'actualizar', 'Poner lo del antiguo', ' is-strong'),
      accion(item.id, 'mantener', 'Mantener lo de aquí'),
      accion(item.id, 'ignorar', 'No volver a avisar'),
    ]);
  }
  if (item.estado === 'revisar') return asignador(item);
  if (item.estado === 'importado' && item.origen !== 'dia') {
    return h('div', { class: 'ant-actions' }, accion(item.id, 'quitar', 'Quitar y no volver a traer', ' is-danger'));
  }
  if (item.estado === 'ignorado' || item.motivo?.startsWith('Ya estaba')) {
    return h('div', { class: 'ant-actions' }, accion(item.id, 'traer', 'Traer igualmente'));
  }
  return null;
}

function fila(item) {
  // Un cambio trae una línea por campo: «Campo: valor (antiguo) / valor (nuevo)».
  const motivo = item.estado === 'cambio' && item.motivo
    ? h('ul', { class: 'ant-diffs' }, item.motivo.split('\n').map((p) => h('li', { text: p })))
    : item.motivo ? h('p', { class: 'ant-reason', text: item.motivo }) : null;
  return h('li', { class: `ant-item is-${item.estado}` }, [
    h('div', { class: 'ant-item-head' }, [
      h('span', { class: 'ant-kind', text: ORIGEN[item.origen] ?? item.origen }),
      h('strong', { class: 'ant-title', text: item.titulo }),
      h('span', { class: 'ant-detail', text: item.detalle }),
    ]),
    motivo,
    acciones(item),
  ]);
}

function render() {
  const vista = VISTAS.find((v) => v.id === state.vista);
  state.els.body.replaceChildren(
    panelEstado(),
    tiles(),
    pestanas(),
    h('section', { class: 'stat-card is-table ant-list' }, state.items.length
      ? h('ul', { class: 'ant-items' }, state.items.map(fila))
      : h('p', { class: 'notice', text: vista.vacio })),
  );
}

async function load() {
  const [estado, items] = await Promise.all([
    api('GET', '/api/antiguo/estado'),
    api('GET', `/api/antiguo/items?vista=${state.vista}`),
  ]);
  if (!estado.ok || !items.ok) {
    state.els.body.replaceChildren(h('p', { class: 'notice', text: (estado.ok ? items : estado).error }));
    return;
  }
  state.estado = estado.data;
  state.items = items.data;
  history.replaceState(history.state, '', `${BASE_PATH}${state.vista === 'cambios' ? '' : `?vista=${state.vista}`}`);
  render();
}

async function sincronizar() {
  state.ocupado = true;
  render();
  const r = await api('POST', '/api/antiguo/sincronizar');
  state.ocupado = false;
  if (!r.ok) {
    showToast(r.error, { tone: 'error' });
  } else {
    const d = r.data;
    const pend = d.cambios + d.revisar;
    showToast(`Traído: ${d.dias} días, ${d.gastos} gastos, ${d.mensuales} mensuales y ${d.adjuntos} PDF.${pend ? ` ${pend} para decidir.` : ''}`);
  }
  await load();
}

async function resolver(boton) {
  const body = { accion: boton.dataset.accion };
  if (body.accion === 'asignar') {
    const caja = boton.closest('.ant-assign');
    const elegido = caja.querySelector('[data-gasto]').value;
    body.tipo = caja.querySelector('[data-tipo]').value;
    if (!elegido) {
      showToast('Elige a qué gasto va el archivo.', { tone: 'error' });
      return;
    }
    if (elegido === 'nuevo') {
      body.gasto_id = 'nuevo';
      body.concepto = caja.querySelector('[data-concepto]').value.trim();
      body.importe = caja.querySelector('[data-importe]').value.trim();
      if (!body.concepto || !body.importe) {
        showToast('Escribe el comercio y el importe de la factura.', { tone: 'error' });
        return;
      }
    } else {
      body.gasto_id = Number(elegido);
    }
  }
  boton.disabled = true;
  const r = await api('POST', `/api/antiguo/items/${boton.dataset.item}`, body);
  if (!r.ok) {
    boton.disabled = false;
    showToast(r.error, { tone: 'error' });
    return;
  }
  showToast({
    actualizar: 'Actualizado con lo del antiguo.', mantener: 'Se queda lo de aquí.', ignorar: 'No se volverá a avisar.',
    quitar: 'Quitado: no se volverá a traer.', traer: 'Traído.', asignar: 'Archivo guardado en el gasto.',
  }[body.accion]);
  await load();
}

function bindEvents(root) {
  // Al elegir «Otros» aparecen los campos del gasto nuevo.
  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-gasto]');
    if (!select) return;
    const campos = select.closest('.ant-assign').querySelector('[data-nuevo]');
    campos.hidden = select.value !== 'nuevo';
    if (!campos.hidden) campos.querySelector('[data-concepto]').focus();
  });
  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-vista]');
    if (tab) {
      state.vista = tab.dataset.vista;
      load();
      return;
    }
    if (event.target.closest('[data-sync]')) {
      sincronizar();
      return;
    }
    const boton = event.target.closest('button[data-accion]');
    if (boton) resolver(boton);
  });
}

/** Pinta Admin › Sistema antiguo. La pestaña viaja en la URL (?vista=). */
export function renderAntiguo({ main, params, backHref }) {
  const pedida = params.get('vista');
  state.vista = VISTAS.some((v) => v.id === pedida) ? pedida : 'cambios';
  state.ocupado = false;
  const body = h('div', { class: 'log-body ant-body' }, h('p', { class: 'notice', text: 'Cargando…' }));
  const root = h('div', { class: 'recurring log-view' }, [header(backHref), stagger(body, 3)]);
  state.els = { root, body };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Sistema antiguo · Puntapié';
  load();
  return root.querySelector('h1');
}
