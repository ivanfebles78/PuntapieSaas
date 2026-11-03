import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Ticket de venta (factura simplificada) para la impresora térmica de 80 mm.
// Se imprime con la impresora de Windows desde Chrome: la hoja de estilos de
// impresión deja visible solo el ticket. Con Chrome en modo quiosco y
// «--kiosk-printing», sale directamente sin el cuadro de impresión.

const METODO = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos', vales: 'Vale', abono: 'Abono' });
const fila = (izq, der, cls = '') => h('div', { class: `tk-fila ${cls}` }, [h('span', { text: izq }), h('span', { text: der })]);

// «cambio»: los tickets de cambio de antes de la serie rectificativa.
const esCambio = (t) => t.tipo === 'cambio';
const talla = (x) => (x.talla && x.talla !== 'Única' ? ` · T. ${x.talla}` : '');

function cabecera(tienda) {
  return h('div', { class: 'tk-cab' }, [
      h('strong', { class: 'tk-nombre', text: tienda.nombre }),
      h('span', { text: tienda.razonSocial }),
      h('span', { text: `NIF ${tienda.cif}` }),
      h('span', { text: tienda.direccion }),
      h('span', { text: `Tel. ${tienda.telefono}` }),
    ]);
}

const pieIgic = (t, texto) => [
  h('div', { class: 'tk-sep' }),
  fila('Base imponible', formatEuros(t.igic.base_cent)),
  fila(`IGIC ${t.igic.pct} %`, formatEuros(t.igic.cuota_cent)),
  h('p', { class: 'tk-pie', text: texto }),
];

/** Factura rectificativa de una devolución: lo devuelto en negativo y dónde se abona. */
function rectificativaDom(t) {
  return h('div', { class: 'tk' }, [
    cabecera(t.tienda),
    h('div', { class: 'tk-sep' }),
    fila(`Factura rectificativa ${t.numero}`, ''),
    fila(t.fecha, `Le atendió: ${t.vendedor}`),
    t.rectifica.length ? fila(`Rectifica: ${t.rectifica.join(', ')}`, '') : null,
    fila('Motivo: devolución del cliente', ''),
    h('div', { class: 'tk-sep' }),
    ...t.devueltos.map((d) => fila(`${d.cantidad} × ${d.descripcion}${talla(d)}`, formatEuros(-d.credito_cent))),
    h('div', { class: 'tk-sep' }),
    fila('TOTAL', formatEuros(-t.total_cent), 'tk-total'),
    t.vinculado ? fila(`Abonado en la venta ${t.vinculado}`, '') : null,
    t.vale_emitido ? fila(`Vale ${t.vale_emitido.codigo}`, formatEuros(t.vale_emitido.importe_cent), 'tk-total') : null,
    ...pieIgic(t, 'No se devuelve dinero: el importe se abona en una compra o en un vale.'),
  ]);
}

/** El ticket (venta, cambio antiguo o rectificativa) como nodo DOM (para verlo en pantalla y para imprimirlo). */
export function ticketDom(t) {
  if (t.tipo === 'rectificativa') return rectificativaDom(t);
  const tienda = t.tienda;
  return h('div', { class: 'tk' }, [
    cabecera(tienda),
    h('div', { class: 'tk-sep' }),
    fila(`${esCambio(t) ? 'Cambio' : 'Factura simplificada'} ${t.numero}`, ''),
    fila(t.fecha, `Le atendió: ${t.vendedor}`),
    h('div', { class: 'tk-sep' }),
    ...(esCambio(t) ? [
      h('div', { class: 'tk-desc', text: 'DEVUELVE' }),
      ...t.devueltos.map((d) => fila(`${d.cantidad} × ${d.descripcion}${talla(d)}`, `−${formatEuros(d.credito_cent)}`)),
      t.lineas.length ? h('div', { class: 'tk-desc', text: 'SE LLEVA' }) : '',
    ] : []),
    ...t.lineas.flatMap((l) => [
      h('div', { class: 'tk-desc', text: `${l.descripcion}${talla(l)}` }),
      fila(`${l.cantidad} × ${formatEuros(l.precio_cent)}`, formatEuros(l.cantidad * l.precio_cent)),
      l.descuento_cent ? fila('  Descuento', `−${formatEuros(l.descuento_cent)}`) : null,
    ]),
    h('div', { class: 'tk-sep' }),
    t.descuento_cent ? fila('Subtotal', formatEuros(t.subtotal_cent)) : null,
    t.descuento_cent ? fila('Descuentos', `−${formatEuros(t.descuento_cent)}`) : null,
    esCambio(t) ? fila('Lo nuevo', formatEuros(t.subtotal_cent - t.descuento_cent)) : null,
    esCambio(t) ? fila('Lo devuelto', `−${formatEuros(t.credito_cent)}`) : null,
    fila(esCambio(t) ? 'A PAGAR' : 'TOTAL', formatEuros(t.total_cent), 'tk-total'),
    t.vale_emitido ? fila(`Vale ${t.vale_emitido.codigo}`, formatEuros(t.vale_emitido.importe_cent), 'tk-total') : null,
    ...t.pagos.map((p) => fila(pagoTexto(p, t), formatEuros(p.entregado_cent ?? p.importe_cent))),
    t.cambio_cent ? fila('Cambio', formatEuros(t.cambio_cent)) : null,
    ...pieIgic(t, 'IGIC incluido. Gracias por su compra.'),
  ]);
}

function pagoTexto(p, t) {
  if (p.vale) return `Vale ${p.vale}`;
  if (p.metodo === 'abono') return `Abono ${t.vinculado ?? ''}`.trim();
  return METODO[p.metodo] ?? p.metodo;
}

/** Imprime uno o varios tickets seguidos (p. ej. la rectificativa y la venta de un cambio). */
export function imprimirTicket(...tickets) {
  imprimir(h('div', {}, tickets.filter(Boolean).flatMap((t, i) => [i ? h('div', { class: 'tk-corte' }) : '', ticketDom(t)])));
}

/** Imprime un nodo en la térmica: la hoja de impresión solo deja ver `.tk-print`. */
export function imprimir(nodo) {
  document.querySelector('.tk-print')?.remove();
  const zona = h('div', { class: 'tk-print', 'aria-hidden': 'true' }, nodo);
  document.body.append(zona);
  const limpiar = () => { zona.remove(); window.removeEventListener('afterprint', limpiar); };
  window.addEventListener('afterprint', limpiar);
  window.print();
}
