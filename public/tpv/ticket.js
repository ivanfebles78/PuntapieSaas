import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Ticket de venta (factura simplificada) para la impresora térmica de 80 mm.
// Se imprime con la impresora de Windows desde Chrome: la hoja de estilos de
// impresión deja visible solo el ticket. Con Chrome en modo quiosco y
// «--kiosk-printing», sale directamente sin el cuadro de impresión.

const METODO = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos', vales: 'Vale' });
const fila = (izq, der, cls = '') => h('div', { class: `tk-fila ${cls}` }, [h('span', { text: izq }), h('span', { text: der })]);

/** El ticket como nodo DOM (sirve para verlo en pantalla y para imprimirlo). */
export function ticketDom(t) {
  const tienda = t.tienda;
  return h('div', { class: 'tk' }, [
    h('div', { class: 'tk-cab' }, [
      h('strong', { class: 'tk-nombre', text: tienda.nombre }),
      h('span', { text: tienda.razonSocial }),
      h('span', { text: `NIF ${tienda.cif}` }),
      h('span', { text: tienda.direccion }),
      h('span', { text: `Tel. ${tienda.telefono}` }),
    ]),
    h('div', { class: 'tk-sep' }),
    fila(`Factura simplificada ${t.numero}`, ''),
    fila(t.fecha, `Le atendió: ${t.vendedor}`),
    h('div', { class: 'tk-sep' }),
    ...t.lineas.flatMap((l) => [
      h('div', { class: 'tk-desc', text: `${l.descripcion}${l.talla && l.talla !== 'Única' ? ` · T. ${l.talla}` : ''}` }),
      fila(`${l.cantidad} × ${formatEuros(l.precio_cent)}`, formatEuros(l.cantidad * l.precio_cent)),
      l.descuento_cent ? fila('  Descuento', `−${formatEuros(l.descuento_cent)}`) : null,
    ]),
    h('div', { class: 'tk-sep' }),
    t.descuento_cent ? fila('Subtotal', formatEuros(t.subtotal_cent)) : null,
    t.descuento_cent ? fila('Descuentos', `−${formatEuros(t.descuento_cent)}`) : null,
    fila('TOTAL', formatEuros(t.total_cent), 'tk-total'),
    ...t.pagos.map((p) => fila(METODO[p.metodo] ?? p.metodo, formatEuros(p.entregado_cent ?? p.importe_cent))),
    t.cambio_cent ? fila('Cambio', formatEuros(t.cambio_cent)) : null,
    h('div', { class: 'tk-sep' }),
    fila(`Base imponible`, formatEuros(t.igic.base_cent)),
    fila(`IGIC ${t.igic.pct} %`, formatEuros(t.igic.cuota_cent)),
    h('p', { class: 'tk-pie', text: 'IGIC incluido. Gracias por su compra.' }),
  ]);
}

/** Imprime el ticket con la impresora predeterminada (la térmica). */
export function imprimirTicket(t) {
  imprimir(ticketDom(t));
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
