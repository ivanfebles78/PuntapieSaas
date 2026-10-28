import { h } from '../dom.js';
import { showToast } from '../toast.js';
import { centToEur, eurToCent } from './util.js';

// Productos que llegarán con un pedido o factura: tabla editable dentro de la
// tarjeta de «Importar PDF» (y del detalle de un documento ya guardado). Al
// guardar, quedan pendientes de recibir en Stock.
//
// Las facturas que solo dan tramos («18-25 · 8 pares») traen una fila por
// talla con 0 unidades y su `tramo`: hay que repartir los pares antes de guardar.
// También se pueden añadir productos a mano.

const unidades = (lineas) => lineas.reduce((s, l) => s + l.cantidad, 0);
const FACTOR_MAX = 20;

/** Botones para calcular el PVP de todas las filas multiplicando el coste. */
function pvpDesdeCoste() {
  return h('div', { class: 'plines-pvp', role: 'group', 'aria-label': 'Calcular el PVP desde el coste' }, [
    h('span', { class: 'plines-pvp-label', text: 'PVP = coste ×' }),
    h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-pvp-factor': '2', title: 'PVP = 2 × coste en todas las filas', text: '2x' }),
    h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-pvp-factor': '2.5', title: 'PVP = 2,5 × coste en todas las filas', text: '2.5x' }),
    h('input', { type: 'text', class: 'pinput num plines-pvp-libre', name: 'pvp_factor', inputmode: 'decimal', placeholder: 'libre', 'aria-label': 'Multiplicador libre (por ejemplo 1,8)' }),
    h('button', { class: 'pbtn pbtn-sm pbtn-primary', type: 'button', 'data-pvp-libre': '', text: 'Calcular' }),
  ]);
}

/** PVP de cada fila con coste = coste × factor (redondeado al céntimo). Devuelve cuántas se rellenaron. */
function aplicarFactor(card, factor) {
  let n = 0;
  card.querySelectorAll('tr[data-linea]').forEach((tr) => {
    const coste = eurToCent(tr.querySelector('[data-k=coste]').value);
    if (coste == null) return;
    const pvp = tr.querySelector('[data-k=pvp]');
    pvp.value = centToEur(Math.round(coste * factor));
    pvp.dataset.prev = pvp.value;
    n += 1;
  });
  return n;
}

const docLabel = (d) => `${d.tipo === 'factura' ? 'la factura' : 'el pedido'} ${d.numero}`;

function fila(l) {
  const input = (k, value, attrs = {}) => h('input', { class: 'pinput', 'data-k': k, value: value ?? '', ...attrs });
  return h('tr', { 'data-linea': '', 'data-tramo': l.tramo?.id ?? null }, [
    h('td', {}, input('referencia', l.referencia, { class: 'pinput mono', 'aria-label': 'Referencia' })),
    h('td', {}, input('modelo', l.modelo, { 'aria-label': 'Modelo' })),
    h('td', {}, input('color', l.color, { 'aria-label': 'Color' })),
    h('td', {}, input('talla', l.talla === '' ? '' : String(l.talla), { type: 'number', min: '0', max: '60', class: 'pinput num', 'aria-label': 'Talla (0 = sin talla)' })),
    h('td', {}, input('cantidad', String(l.cantidad), { type: 'number', min: '0', max: '1000', class: 'pinput num', 'aria-label': 'Unidades' })),
    h('td', {}, input('coste', centToEur(l.coste_cent), { inputmode: 'decimal', class: 'pinput num', 'aria-label': 'Coste' })),
    h('td', {}, input('pvp', centToEur(l.pvp_cent), { inputmode: 'decimal', class: 'pinput num', 'aria-label': 'PVP', 'data-prev': centToEur(l.pvp_cent) })),
    h('td', {}, h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-quitar-linea': '', 'aria-label': 'Quitar línea', text: '✕' })),
  ]);
}

/** Cabecera de un tramo a repartir, antes de sus tallas. */
function cabeceraTramo(l) {
  const t = l.tramo;
  return h('tr', { class: 'plines-tramo', 'data-tramo-head': t.id, 'data-total': String(t.total) }, h('td', { colspan: '8' }, [
    h('strong', { text: `${l.referencia} · ${l.modelo} · ${l.color}` }),
    ` — tallas ${t.desde}-${t.hasta}: reparte ${t.total} pares · `,
    h('span', { class: 'plines-quedan', 'data-quedan': '', text: `faltan ${t.total}` }),
  ]));
}

function filasTabla(lineas) {
  const vistos = new Set();
  return lineas.flatMap((l) => {
    if (!l.tramo || vistos.has(l.tramo.id)) return [fila(l)];
    vistos.add(l.tramo.id);
    return [cabeceraTramo(l), fila(l)];
  });
}

/**
 * Bloque de productos. `yaRegistrados` = documento enlazado que ya los tiene
 * dados de alta (el pedido de una factura, o la factura de un pedido): no se duplican.
 */
export function bloqueLineas(e, yaRegistrados) {
  if (yaRegistrados) {
    return h('div', { class: 'plines' }, [
      h('h4', { class: 'psection-title', text: 'Productos' }),
      h('p', { class: 'pmuted', text: `Ya están dados de alta con ${docLabel(yaRegistrados)}: no se duplican.` }),
    ]);
  }
  const lineas = e.lineas ?? [];
  const conTramos = lineas.some((l) => l.tramo);
  const resumen = h('span', { class: 'pmuted small', 'data-lineas-resumen': '', text: resumenTexto(lineas) });
  return h('div', { class: 'plines' }, [
    h('div', { class: 'plines-head' }, [
      h('label', { class: 'pcheck' }, [h('input', { type: 'checkbox', name: 'con_lineas', checked: lineas.length > 0 }), h('span', { text: 'Dar de alta los productos como pendientes de recibir' })]),
      pvpDesdeCoste(),
      h('label', { class: 'pfield plines-marca' }, [h('span', { text: 'Marca' }), h('input', { type: 'text', name: 'marca', value: lineas[0]?.marca ?? '' })]),
    ]),
    h('details', { class: 'plines-detail', open: lineas.length > 0 && (lineas.length <= 40 || conTramos) }, [
      h('summary', {}, [lineas.length ? 'Productos que llegarán · ' : 'Sin productos leídos del PDF · ', resumen]),
      h('p', { class: 'pmuted small', text: [
        conTramos ? 'Esta factura no dice cuántos pares hay de cada talla: reparte los de cada tramo en sus tallas (deben sumar el total).' : null,
        'Revisa modelo, color y PVP (sale en la etiqueta). Al cambiar un PVP, se cambia también en las demás tallas de la misma referencia y color que tenían ese precio.',
      ].filter(Boolean).join(' ') }),
      h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable plines-table' }, [
        h('thead', {}, h('tr', {}, ['Ref.', 'Modelo', 'Color', 'Talla', 'Uds.', 'Coste €', 'PVP €', ''].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, filasTabla(lineas)),
      ])),
      h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-anadir-linea': '', text: '＋ Añadir producto' }),
    ]),
  ]);
}

function resumenTexto(lineas) {
  return lineas.length ? `${lineas.length} líneas · ${unidades(lineas)} unidades` : 'añádelos a mano si hace falta';
}

/** Eventos de la tabla (dentro de la lista de tarjetas o de la sección del detalle). */
export function enlazarLineas(lista) {
  lista.addEventListener('click', (ev) => {
    const factorBtn = ev.target.closest('[data-pvp-factor], [data-pvp-libre]');
    if (factorBtn) return void calcularPvp(factorBtn);
    const quitar = ev.target.closest('[data-quitar-linea]');
    const anadir = ev.target.closest('[data-anadir-linea]');
    if (!quitar && !anadir) return;
    const card = (quitar ?? anadir).closest('.review');
    if (quitar) quitar.closest('tr').remove();
    if (anadir) {
      const tbody = card.querySelector('.plines-table tbody');
      const ultima = [...tbody.querySelectorAll('tr[data-linea]')].at(-1);
      const g = (k) => ultima?.querySelector(`[data-k=${k}]`).value ?? '';
      // La nueva fila copia referencia, modelo, color y precios de la última: así añadir otra talla es rápido.
      const nueva = fila({ referencia: g('referencia'), modelo: g('modelo'), color: g('color'), talla: '', cantidad: 1, coste_cent: eurToCent(g('coste')), pvp_cent: eurToCent(g('pvp')) });
      tbody.append(nueva);
      card.querySelector('[name=con_lineas]').checked = true;
      nueva.querySelector('[data-k=referencia]').focus();
    }
    actualizarResumen(card);
  });
  lista.addEventListener('change', (ev) => {
    const input = ev.target.closest('[data-k]');
    if (!input) return;
    const card = input.closest('.review');
    if (input.dataset.k === 'pvp') propagarPvp(input);
    actualizarResumen(card);
  });
}

function calcularPvp(boton) {
  const card = boton.closest('.review');
  let factor = Number(boton.dataset.pvpFactor);
  if (boton.matches('[data-pvp-libre]')) {
    factor = Number(String(card.querySelector('[name=pvp_factor]').value).trim().replace(',', '.'));
    if (!Number.isFinite(factor) || factor <= 0 || factor > FACTOR_MAX) {
      return void showToast(`Escribe un multiplicador entre 0 y ${FACTOR_MAX}, por ejemplo 1,8.`, { tone: 'error' });
    }
  }
  const n = aplicarFactor(card, factor);
  return void showToast(n ? `PVP calculado (coste × ${String(factor).replace('.', ',')}) en ${n} línea${n === 1 ? '' : 's'}.` : 'No hay líneas con coste para calcular el PVP.', n ? undefined : { tone: 'error' });
}

function propagarPvp(input) {
  const tr = input.closest('tr');
  const clave = (row) => `${row.querySelector('[data-k=referencia]').value}|${row.querySelector('[data-k=color]').value}`.toLowerCase();
  const anterior = input.dataset.prev;
  tr.closest('tbody').querySelectorAll('tr[data-linea]').forEach((row) => {
    const pvp = row.querySelector('[data-k=pvp]');
    if (row === tr || clave(row) !== clave(tr) || pvp.value !== anterior) return;
    pvp.value = input.value;
    pvp.dataset.prev = input.value;
  });
  input.dataset.prev = input.value;
}

/** Pares que faltan por repartir en cada tramo: { id: faltan } (negativo si sobran). */
function repartos(card) {
  const out = {};
  card.querySelectorAll('[data-tramo-head]').forEach((head) => {
    const id = head.dataset.tramoHead;
    const puestos = [...card.querySelectorAll(`tr[data-tramo="${CSS.escape(id)}"] [data-k=cantidad]`)].reduce((s, i) => s + (Number(i.value) || 0), 0);
    out[id] = Number(head.dataset.total) - puestos;
  });
  return out;
}

function actualizarResumen(card) {
  const ls = leerLineas(card) ?? [];
  const r = card.querySelector('[data-lineas-resumen]');
  if (r) r.textContent = resumenTexto(ls);
  for (const [id, faltan] of Object.entries(repartos(card))) {
    const head = card.querySelector(`[data-tramo-head="${CSS.escape(id)}"]`);
    head.classList.toggle('is-ok', faltan === 0);
    head.querySelector('[data-quedan]').textContent = faltan === 0 ? 'repartido ✓' : faltan > 0 ? `faltan ${faltan}` : `sobran ${-faltan}`;
  }
}

/** Mensaje si algún tramo no está bien repartido (null si todo cuadra o no se dan de alta productos). */
export function errorReparto(card) {
  if (!card.querySelector('[name=con_lineas]')?.checked) return null;
  const mal = Object.values(repartos(card)).filter((f) => f !== 0).length;
  return mal ? `Reparte los pares por tallas: ${mal} tramo${mal === 1 ? '' : 's'} no suma${mal === 1 ? '' : 'n'} su total.` : null;
}

/** Líneas de la tarjeta para enviar, o null si no hay que dar de alta productos. */
export function leerLineas(card) {
  const check = card.querySelector('[name=con_lineas]');
  if (!check?.checked) return null;
  const marca = card.querySelector('[name=marca]')?.value.trim() ?? '';
  return [...card.querySelectorAll('tr[data-linea]')].map((tr) => {
    const g = (k) => tr.querySelector(`[data-k=${k}]`).value.trim();
    return {
      marca,
      referencia: g('referencia'),
      modelo: g('modelo'),
      color: g('color'),
      talla: Number(g('talla') || 0),
      cantidad: Number(g('cantidad') || 0),
      coste_cent: eurToCent(g('coste')),
      pvp_cent: eurToCent(g('pvp')),
    };
  }).filter((l) => l.cantidad > 0);
}
