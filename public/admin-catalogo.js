import { api } from './api.js';
import { openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

// Admin › Catálogo: los tipos de producto (con las tallas que admite cada uno),
// sus subtipos y los fabricantes, con los tipos y subtipos para los que se
// ofrece cada uno al dar de alta un producto. Lo usado en el inventario no se
// puede borrar; el servidor explica por qué.

const API = '/api/stock/catalogo';
const state = { catalogo: null, filtro: '', tipoFiltro: '', els: null };

const n = (x, uno, varios) => `${x} ${x === 1 ? uno : varios}`;
const productos = (x) => (x ? n(x, 'producto', 'productos') : 'Sin productos');
const tipoDe = (id) => state.catalogo.tipos.find((t) => t.id === id);
const subtipoDe = (id) => state.catalogo.tipos.flatMap((t) => t.subtipos.map((s) => ({ ...s, tipo: t.id }))).find((s) => s.id === id);
const claseTxt = (id) => state.catalogo.clases.find((c) => c.id === id)?.texto ?? id;
const sinTildes = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** «Calzado (Botas, Tenis) · Ropa» o «Todos los tipos». */
function ambitosTxt(ambitos) {
  if (!ambitos.length) return ['Todos los tipos'];
  const porTipo = new Map();
  for (const a of ambitos) {
    const lista = porTipo.get(a.tipo) ?? [];
    porTipo.set(a.tipo, a.subtipo_id ? [...lista, subtipoDe(a.subtipo_id)?.nombre ?? '?'] : lista);
  }
  return [...porTipo].map(([tipo, subs]) => `${tipoDe(tipo)?.nombre ?? tipo}${subs.length ? ` (${[...subs].sort((a, b) => a.localeCompare(b, 'es')).join(', ')})` : ''}`);
}

/* ---------- Pintar ---------- */

function header(backHref) {
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, [
      h('div', {}, [
        stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · Stock' }), 1),
        stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Catálogo' }), 1),
        stagger(h('p', { class: 'module-summary', text: 'Tipos de producto con sus tallas, subtipos y fabricantes: lo que se ofrece al dar de alta un producto.' }), 2),
      ]),
      stagger(h('div', { class: 'cat-ctas' }, [
        h('button', { class: 'cta', type: 'button', 'data-write': '', 'data-nuevo-fabricante': '' }, [
          h('span', { text: 'Nuevo fabricante' }), h('span', { class: 'bubble bubble-cta' }, icon('truck', 'ico ico-sm')),
        ]),
        h('button', { class: 'chip-btn cat-cta-ghost', type: 'button', 'data-write': '', 'data-nuevo-tipo': '', text: '+ Tipo de producto' }),
      ]), 2),
    ]),
  ]);
}

function tarjetaTipo(t) {
  return h('article', { class: 'cat-tipo', 'data-tipo': t.id }, [
    h('div', { class: 'cat-tipo-head' }, [
      h('h3', { class: 'cat-tipo-nombre', text: t.nombre }),
      h('span', { class: `cat-cuenta${t.productos ? '' : ' is-cero'}`, text: productos(t.productos) }),
    ]),
    h('dl', { class: 'cat-reglas' }, [
      h('dt', { text: 'Tallas' }), h('dd', { text: t.tallas.map(claseTxt).join(' · ') }),
      h('dt', { text: 'Color' }), h('dd', { text: t.color ? 'Obligatorio' : 'Opcional' }),
    ]),
    h('div', { class: 'cat-subtipos' }, [
      h('p', { class: 'cat-mini', text: t.subtipos.length ? 'Subtipos' : 'Sin subtipos' }),
      h('ul', { class: 'cat-chips' }, [
        ...t.subtipos.map((s) => h('li', {}, h('button', {
          class: 'cat-chip', type: 'button', 'data-subtipo': String(s.id), title: `${s.nombre}: ${productos(s.productos)}`,
        }, [h('span', { text: s.nombre }), s.productos ? h('span', { class: 'cat-chip-n', text: String(s.productos) }) : null]))),
        h('li', {}, h('button', { class: 'cat-chip is-add', type: 'button', 'data-write': '', 'data-nuevo-subtipo': t.id, text: '+ Subtipo' })),
      ]),
    ]),
    h('div', { class: 'cat-acciones' }, [
      h('button', { class: 'chip-btn', type: 'button', 'data-write': '', 'data-editar-tipo': t.id, text: 'Editar' }),
      h('button', { class: 'chip-btn cat-borrar', type: 'button', 'data-write': '', 'data-borrar-tipo': t.id, text: 'Borrar' }),
    ]),
  ]);
}

function filaMarca(m) {
  return h('li', { class: 'cat-marca', 'data-marca': String(m.id) }, [
    h('div', { class: 'cat-marca-main' }, [
      h('span', { class: 'cat-marca-nombre', text: m.nombre }),
      h('ul', { class: 'cat-para' }, ambitosTxt(m.ambitos).map((t) => h('li', { class: m.ambitos.length ? '' : 'is-todos', text: t }))),
    ]),
    h('span', { class: `cat-cuenta${m.productos ? '' : ' is-cero'}`, text: productos(m.productos) }),
    h('div', { class: 'cat-acciones' }, [
      h('button', { class: 'chip-btn', type: 'button', 'data-write': '', 'data-editar-marca': String(m.id), text: 'Editar' }),
      h('button', { class: 'chip-btn cat-borrar', type: 'button', 'data-write': '', 'data-borrar-marca': String(m.id), text: 'Borrar' }),
    ]),
  ]);
}

function marcasVisibles() {
  const q = sinTildes(state.filtro.trim());
  return state.catalogo.marcas.filter((m) => (!q || sinTildes(m.nombre).includes(q))
    && (!state.tipoFiltro || !m.ambitos.length || m.ambitos.some((a) => a.tipo === state.tipoFiltro)));
}

function pintarMarcas() {
  const lista = marcasVisibles();
  state.els.marcas.replaceChildren(lista.length
    ? h('ul', { class: 'cat-marcas' }, lista.map(filaMarca))
    : h('p', { class: 'notice', text: state.catalogo.marcas.length ? 'Ningún fabricante con ese filtro.' : 'Aún no hay fabricantes: se añaden aquí o solos al dar de alta un producto.' }));
}

function pintar() {
  const c = state.catalogo;
  const buscar = h('input', { class: 'pinput cat-buscar', type: 'search', placeholder: 'Buscar fabricante', 'aria-label': 'Buscar fabricante', value: state.filtro, 'data-buscar': '' });
  const tipo = h('select', { class: 'pinput', 'aria-label': 'Filtrar por tipo', 'data-tipo-filtro': '' }, [
    h('option', { value: '', text: 'Todos los tipos' }),
    ...c.tipos.map((t) => h('option', { value: t.id, text: t.nombre, selected: t.id === state.tipoFiltro })),
  ]);
  state.els.marcas = h('div', {});
  state.els.body.replaceChildren(
    h('section', { class: 'cat-seccion', 'aria-labelledby': 'cat-h-tipos' }, [
      h('h2', { class: 'opening-heading', id: 'cat-h-tipos' }, ['Tipos de producto', h('span', { class: 'opening-count', text: String(c.tipos.length) })]),
      h('div', { class: 'cat-tipos' }, c.tipos.map(tarjetaTipo)),
    ]),
    h('section', { class: 'cat-seccion', 'aria-labelledby': 'cat-h-marcas' }, [
      h('div', { class: 'cat-marcas-head' }, [
        h('h2', { class: 'opening-heading', id: 'cat-h-marcas' }, ['Fabricantes', h('span', { class: 'opening-count', text: String(c.marcas.length) })]),
        h('div', { class: 'cat-filtros' }, [buscar, tipo]),
      ]),
      state.els.marcas,
    ]),
  );
  pintarMarcas();
}

async function cargar() {
  const res = await api('GET', API);
  if (!res.ok) {
    state.els.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
    return;
  }
  state.catalogo = res.data;
  pintar();
}

/** Tras un cambio: el servidor devuelve el catálogo ya actualizado. */
function aplicar(res, mensaje) {
  if (res?.data?.catalogo) state.catalogo = res.data.catalogo;
  pintar();
  showToast(mensaje);
}

/* ---------- Diálogos ---------- */

const campo = (label, control, ayuda) => h('label', { class: 'pfield' }, [h('span', { text: label }), control, ayuda ? h('small', { class: 'pmuted', text: ayuda }) : null]);
const casilla = (texto, attrs) => h('label', { class: 'cat-check' }, [h('input', { type: 'checkbox', ...attrs }), h('span', { text: texto })]);

async function dialogoTipo(t) {
  const nombre = h('input', { type: 'text', maxlength: '40', value: t?.nombre ?? '', required: true, autocomplete: 'off' });
  const clases = h('fieldset', { class: 'cat-fieldset' }, [
    h('legend', { text: 'Tallas que admite' }),
    ...state.catalogo.clases.map((c) => casilla(c.texto, { value: c.id, 'data-clase': '', checked: t ? t.tallas.includes(c.id) : c.id === 'unica' })),
  ]);
  const color = casilla('El color es obligatorio', { checked: t ? t.color : true });
  const res = await openDialog({
    eyebrow: 'Catálogo',
    title: t ? `Editar ${t.nombre}` : 'Nuevo tipo de producto',
    lead: t?.productos ? `Tiene ${productos(t.productos)}: no se puede quitar una talla ni pedir el color si alguno dejaría de cumplirlo.` : 'Por ejemplo, «Bolsos» con talla única y sin color obligatorio.',
    content: h('div', { class: 'pform' }, [campo('Nombre', nombre), clases, color]),
    submitLabel: t ? 'Guardar' : 'Crear tipo',
    onSubmit: async (form) => {
      const body = {
        nombre: nombre.value.trim(),
        tallas: [...form.querySelectorAll('[data-clase]:checked')].map((x) => x.value),
        color: color.querySelector('input').checked,
      };
      if (!body.nombre) return { error: 'Escribe el nombre del tipo.' };
      if (!body.tallas.length) return { error: 'Marca al menos una clase de talla.' };
      const r = t ? await api('PUT', `${API}/tipos/${encodeURIComponent(t.id)}`, body) : await api('POST', `${API}/tipos`, body);
      return r.ok ? r : { error: r.error };
    },
  });
  if (res?.ok) aplicar(res, t ? 'Tipo guardado.' : `Tipo «${res.data.resultado.nombre}» creado.`);
}

async function confirmarBorrado({ titulo, lead, url, hecho }) {
  const res = await openDialog({
    eyebrow: 'Borrar',
    title: titulo,
    lead,
    submitLabel: 'Borrar',
    tone: 'danger',
    onSubmit: async () => {
      const r = await api('DELETE', url);
      return r.ok ? r : { error: r.error };
    },
  });
  if (res?.ok) aplicar(res, hecho);
}

async function dialogoSubtipo(tipoId, s) {
  const t = tipoDe(tipoId);
  const nombre = h('input', { type: 'text', maxlength: '50', value: s?.nombre ?? '', required: true, autocomplete: 'off' });
  let borrar = false;
  const botonBorrar = s ? h('button', { class: 'btn-text cat-borrar-sub', type: 'button', 'data-write': '', text: 'Borrar este subtipo' }) : null;
  // «Borrar» dentro del diálogo lo cierra y pide confirmación aparte.
  botonBorrar?.addEventListener('click', (event) => {
    borrar = true;
    event.target.closest('form').requestSubmit();
  });
  const res = await openDialog({
    eyebrow: `Catálogo · ${t.nombre}`,
    title: s ? `Subtipo ${s.nombre}` : `Nuevo subtipo de ${t.nombre.toLowerCase()}`,
    lead: s ? (s.productos ? `Lo usan ${productos(s.productos)}.` : 'Ningún producto lo usa todavía.') : 'Por ejemplo «Botas» en calzado o «Pijamas» en ropa.',
    content: h('div', { class: 'pform' }, [campo('Nombre', nombre), botonBorrar]),
    submitLabel: s ? 'Guardar' : 'Crear subtipo',
    onSubmit: async () => {
      if (borrar) return { borrar: true };
      const body = { nombre: nombre.value.trim() };
      if (!body.nombre) return { error: 'Escribe el nombre del subtipo.' };
      const r = s ? await api('PUT', `${API}/subtipos/${s.id}`, body) : await api('POST', `${API}/subtipos`, { ...body, tipo: tipoId });
      return r.ok ? r : { error: r.error };
    },
  });
  if (res?.borrar) {
    await confirmarBorrado({
      titulo: `¿Borrar el subtipo ${s.nombre}?`,
      lead: s.productos ? `Sus ${productos(s.productos)} se quedan sin subtipo (siguen siendo ${t.nombre.toLowerCase()}).` : 'Ningún producto lo usa.',
      url: `${API}/subtipos/${s.id}`,
      hecho: 'Subtipo borrado.',
    });
    return;
  }
  if (res?.ok) aplicar(res, s ? 'Subtipo guardado.' : 'Subtipo creado.');
}

/** Elegir para qué tipos y subtipos se ofrece un fabricante. */
function selectorAmbitos(ambitos) {
  const todos = !ambitos.length;
  const radio = (valor, texto) => h('label', { class: 'cat-check' }, [h('input', { type: 'radio', name: 'cat-para', value: valor, checked: (valor === 'todos') === todos }), h('span', { text: texto })]);
  const grupos = state.catalogo.tipos.map((t) => {
    const entero = ambitos.some((a) => a.tipo === t.id && !a.subtipo_id);
    const tipoChk = h('input', { type: 'checkbox', 'data-amb-tipo': t.id, checked: entero });
    const subs = t.subtipos.map((s) => casilla(s.nombre, { 'data-amb-sub': String(s.id), 'data-de': t.id, checked: entero || ambitos.some((a) => a.subtipo_id === s.id) }));
    return h('div', { class: 'cat-amb-grupo' }, [
      h('label', { class: 'cat-check cat-amb-tipo' }, [tipoChk, h('span', { text: `${t.nombre} (todo)` })]),
      subs.length ? h('div', { class: 'cat-amb-subs' }, subs) : null,
    ]);
  });
  const panel = h('div', { class: 'cat-amb-panel' }, grupos);
  const el = h('fieldset', { class: 'cat-fieldset' }, [h('legend', { text: 'Se ofrece para' }), radio('todos', 'Todos los tipos'), radio('algunos', 'Solo estos tipos o subtipos:'), panel]);
  const sincronizar = () => {
    const algunos = el.querySelector('input[name="cat-para"]:checked')?.value === 'algunos';
    panel.toggleAttribute('data-off', !algunos);
    panel.querySelectorAll('input').forEach((i) => { i.disabled = !algunos; });
    // Con el tipo entero marcado, sus subtipos van incluidos.
    panel.querySelectorAll('[data-amb-tipo]').forEach((tc) => {
      panel.querySelectorAll(`[data-de="${tc.dataset.ambTipo}"]`).forEach((sc) => {
        if (tc.checked) sc.checked = true;
        sc.disabled = !algunos || tc.checked;
      });
    });
  };
  el.addEventListener('change', (event) => {
    // Al desmarcar el tipo entero, sus subtipos se desmarcan para elegir solo algunos.
    const tc = event.target.closest('[data-amb-tipo]');
    if (tc && !tc.checked) panel.querySelectorAll(`[data-de="${tc.dataset.ambTipo}"]`).forEach((sc) => { sc.checked = false; });
    sincronizar();
  });
  sincronizar();
  const leer = () => {
    if (el.querySelector('input[name="cat-para"]:checked')?.value !== 'algunos') return [];
    return state.catalogo.tipos.flatMap((t) => {
      if (panel.querySelector(`[data-amb-tipo="${t.id}"]`).checked) return [{ tipo: t.id, subtipo_id: null }];
      return [...panel.querySelectorAll(`[data-de="${t.id}"]:checked`)].map((x) => ({ tipo: t.id, subtipo_id: Number(x.dataset.ambSub) }));
    });
  };
  return { el, leer, algunos: () => el.querySelector('input[name="cat-para"]:checked')?.value === 'algunos' };
}

async function dialogoMarca(m) {
  const nombre = h('input', { type: 'text', maxlength: '50', value: m?.nombre ?? '', required: true, autocomplete: 'off' });
  const amb = selectorAmbitos(m?.ambitos ?? []);
  const res = await openDialog({
    eyebrow: 'Catálogo',
    title: m ? `Editar ${m.nombre}` : 'Nuevo fabricante',
    lead: m?.productos ? `Tiene ${productos(m.productos)}: si le cambias el nombre, se cambia también en ellos.` : 'Elige para qué tipos se ofrece al dar de alta un producto.',
    content: h('div', { class: 'pform' }, [campo('Nombre', nombre), amb.el]),
    submitLabel: m ? 'Guardar' : 'Crear fabricante',
    onSubmit: async () => {
      const body = { nombre: nombre.value.trim(), ambitos: amb.leer() };
      if (!body.nombre) return { error: 'Escribe el nombre del fabricante.' };
      if (amb.algunos() && !body.ambitos.length) return { error: 'Marca al menos un tipo o subtipo (o elige «Todos los tipos»).' };
      const r = m ? await api('PUT', `${API}/marcas/${m.id}`, body) : await api('POST', `${API}/marcas`, body);
      return r.ok ? r : { error: r.error };
    },
  });
  if (!res?.ok) return;
  const renombrados = res.data.resultado.renombrados;
  aplicar(res, renombrados ? `Fabricante guardado y renombrado en ${productos(renombrados)}.` : m ? 'Fabricante guardado.' : 'Fabricante creado.');
}

/* ---------- Eventos ---------- */

function bindEvents(root) {
  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-buscar]')) return;
    state.filtro = event.target.value;
    pintarMarcas();
  });
  root.addEventListener('change', (event) => {
    if (!event.target.matches('[data-tipo-filtro]')) return;
    state.tipoFiltro = event.target.value;
    pintarMarcas();
  });
  root.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (!b || !state.catalogo) return;
    const d = b.dataset;
    if ('nuevoTipo' in d) dialogoTipo(null);
    else if (d.editarTipo) dialogoTipo(tipoDe(d.editarTipo));
    else if (d.borrarTipo) {
      const t = tipoDe(d.borrarTipo);
      confirmarBorrado({
        titulo: `¿Borrar el tipo ${t.nombre}?`,
        lead: t.productos ? `Tiene ${productos(t.productos)}: cámbiales el tipo en Inventario antes de borrarlo.` : `Se borran también sus ${n(t.subtipos.length, 'subtipo', 'subtipos')}.`,
        url: `${API}/tipos/${encodeURIComponent(t.id)}`,
        hecho: 'Tipo borrado.',
      });
    } else if (d.nuevoSubtipo) dialogoSubtipo(d.nuevoSubtipo, null);
    else if (d.subtipo) {
      const s = subtipoDe(Number(d.subtipo));
      if (s) dialogoSubtipo(s.tipo, s);
    } else if ('nuevoFabricante' in d) dialogoMarca(null);
    else if (d.editarMarca) dialogoMarca(state.catalogo.marcas.find((m) => m.id === Number(d.editarMarca)));
    else if (d.borrarMarca) {
      const m = state.catalogo.marcas.find((x) => x.id === Number(d.borrarMarca));
      confirmarBorrado({
        titulo: `¿Borrar el fabricante ${m.nombre}?`,
        lead: m.productos ? `Tiene ${productos(m.productos)} en el inventario: no se puede borrar (si ha cambiado de nombre, edítalo).` : 'Deja de salir en la lista al dar de alta productos.',
        url: `${API}/marcas/${m.id}`,
        hecho: 'Fabricante borrado.',
      });
    }
  });
}

/** Pinta Admin › Catálogo. */
export function renderCatalogo({ main, backHref }) {
  const body = h('div', { class: 'cat-body' }, h('p', { class: 'notice', text: 'Cargando…' }));
  const root = h('div', { class: 'users catalogo' }, [header(backHref), stagger(body, 3)]);
  state.els = { root, body, marcas: null };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Catálogo · Puntapié';
  cargar();
  return root.querySelector('h1');
}
