import { h } from '../dom.js';
import { centToEur, eurToCent } from './util.js';

// Productos que llegarán con un pedido o factura: tabla editable dentro de la
// tarjeta de «Importar PDF». Al guardar, quedan pendientes de recibir en Stock.

const unidades = (lineas) => lineas.reduce((s, l) => s + l.cantidad, 0);

function fila(l) {
  const input = (k, value, attrs = {}) => h('input', { class: 'pinput', 'data-k': k, value: value ?? '', ...attrs });
  return h('tr', { 'data-linea': '' }, [
    h('td', {}, input('referencia', l.referencia, { class: 'pinput mono', 'aria-label': 'Referencia' })),
    h('td', {}, input('modelo', l.modelo, { 'aria-label': 'Modelo' })),
    h('td', {}, input('color', l.color, { 'aria-label': 'Color' })),
    h('td', {}, input('talla', String(l.talla), { type: 'number', min: '0', max: '60', class: 'pinput num', 'aria-label': 'Talla' })),
    h('td', {}, input('cantidad', String(l.cantidad), { type: 'number', min: '1', max: '1000', class: 'pinput num', 'aria-label': 'Unidades' })),
    h('td', {}, input('coste', centToEur(l.coste_cent), { inputmode: 'decimal', class: 'pinput num', 'aria-label': 'Coste' })),
    h('td', {}, input('pvp', centToEur(l.pvp_cent), { inputmode: 'decimal', class: 'pinput num', 'aria-label': 'PVP', 'data-prev': centToEur(l.pvp_cent) })),
    h('td', {}, h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-quitar-linea': '', 'aria-label': 'Quitar línea', text: '✕' })),
  ]);
}

/**
 * Bloque de productos de una tarjeta. `productosEnPedido` = pedido que ya los
 * tiene registrados (si es su factura), y entonces no se vuelven a dar de alta.
 */
export function bloqueLineas(e, productosEnPedido) {
  if (productosEnPedido) {
    return h('div', { class: 'plines' }, [
      h('h4', { class: 'psection-title', text: 'Productos' }),
      h('p', { class: 'pmuted', text: `Ya están dados de alta con el pedido ${productosEnPedido.numero}: no se duplican.` }),
    ]);
  }
  if (!e.lineas?.length) {
    return e.parser === 'pablosky' && e.tipo === 'factura'
      ? h('p', { class: 'pmuted small plines', text: 'Las facturas de Pablosky no desglosan las tallas: para dar de alta los productos y sacar las etiquetas, importa su «Propuesta de pedido».' })
      : null;
  }
  const marca = e.lineas[0].marca ?? '';
  const resumen = h('span', { class: 'pmuted small', 'data-lineas-resumen': '', text: `${e.lineas.length} líneas · ${unidades(e.lineas)} unidades` });
  return h('div', { class: 'plines' }, [
    h('div', { class: 'plines-head' }, [
      h('label', { class: 'pcheck' }, [h('input', { type: 'checkbox', name: 'con_lineas', checked: true }), h('span', { text: 'Dar de alta los productos como pendientes de recibir' })]),
      h('label', { class: 'pfield plines-marca' }, [h('span', { text: 'Marca' }), h('input', { type: 'text', name: 'marca', value: marca })]),
    ]),
    h('details', { class: 'plines-detail', open: e.lineas.length <= 40 }, [
      h('summary', {}, ['Productos que llegarán · ', resumen]),
      h('p', { class: 'pmuted small', text: 'Revisa modelo, color y PVP (sale en la etiqueta). Al cambiar un PVP, se cambia también en las demás tallas de la misma referencia y color que tenían ese precio.' }),
      h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable plines-table' }, [
        h('thead', {}, h('tr', {}, ['Ref.', 'Modelo', 'Color', 'Talla', 'Uds.', 'Coste €', 'PVP €', ''].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, e.lineas.map(fila)),
      ])),
    ]),
  ]);
}

/** Eventos de la tabla (dentro de la lista de tarjetas). */
export function enlazarLineas(lista) {
  lista.addEventListener('click', (ev) => {
    const quitar = ev.target.closest('[data-quitar-linea]');
    if (!quitar) return;
    const card = quitar.closest('.review');
    quitar.closest('tr').remove();
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

function propagarPvp(input) {
  const tr = input.closest('tr');
  const clave = (row) => `${row.querySelector('[data-k=referencia]').value}|${row.querySelector('[data-k=color]').value}`.toLowerCase();
  const anterior = input.dataset.prev;
  tr.closest('tbody').querySelectorAll('tr').forEach((row) => {
    const pvp = row.querySelector('[data-k=pvp]');
    if (row === tr || clave(row) !== clave(tr) || pvp.value !== anterior) return;
    pvp.value = input.value;
    pvp.dataset.prev = input.value;
  });
  input.dataset.prev = input.value;
}

function actualizarResumen(card) {
  const ls = leerLineas(card) ?? [];
  const r = card.querySelector('[data-lineas-resumen]');
  if (r) r.textContent = `${ls.length} líneas · ${unidades(ls)} unidades`;
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
