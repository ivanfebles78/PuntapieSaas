import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { imprimir } from './ticket.js';

// Vale impreso en la térmica de 80 mm: importe, fechas, código QR (al
// escanearlo en el TPV se ve el vale: saldo, caducidad y usos) y condiciones.

/** El SVG del QR (generado en el servidor) como nodo. */
function qrNodo(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const nodo = document.importNode(doc.documentElement, true);
  nodo.setAttribute('class', 'vl-qr');
  nodo.setAttribute('role', 'img');
  nodo.setAttribute('aria-label', 'Código QR del vale');
  return nodo;
}

export function valeImpresoDom(v) {
  const t = v.tienda ?? {};
  const condiciones = [
    `Vale canjeable por productos en ${t.nombre ?? 'Puntapié'}. No se cambia por dinero.`,
    `Válido hasta el ${v.caduca} (${v.validez_meses === 12 ? '1 año' : `${v.validez_meses} meses`} desde su emisión). Pasada esa fecha no se aceptará.`,
    'Se puede usar en una o varias compras hasta agotar su saldo.',
    'Consérvelo en buen estado: si está tan deteriorado que nuestro sistema no puede leer su código QR y no podemos identificarlo, nos reservamos el derecho a no aceptarlo.',
    `Vale al portador: ${t.nombre ?? 'Puntapié'} no se hace responsable de su pérdida o robo.`,
  ];
  return h('div', { class: 'tk vl' }, [
    h('div', { class: 'tk-cab' }, [
      h('strong', { class: 'tk-nombre', text: t.nombre ?? 'Puntapié' }),
      t.razonSocial ? h('span', { text: `${t.razonSocial} · NIF ${t.cif}` }) : '',
      t.direccion ? h('span', { text: t.direccion }) : '',
      t.telefono ? h('span', { text: `Tel. ${t.telefono}` }) : '',
    ]),
    h('div', { class: 'tk-sep' }),
    h('p', { class: 'vl-titulo', text: 'VALE DE COMPRA' }),
    h('p', { class: 'vl-importe', text: formatEuros(v.importe_cent) }),
    v.qr_svg ? qrNodo(v.qr_svg) : '',
    h('p', { class: 'vl-codigo', text: v.codigo_legible }),
    h('div', { class: 'tk-sep' }),
    h('div', { class: 'tk-fila' }, [h('span', { text: 'Fecha del vale' }), h('span', { text: v.emitido })]),
    h('div', { class: 'tk-fila tk-total' }, [h('span', { text: 'Caduca el' }), h('span', { text: v.caduca })]),
    v.ticket_origen ? h('div', { class: 'tk-fila' }, [h('span', { text: v.ticket_origen.startsWith('R') ? 'Devolución' : 'Cambio' }), h('span', { text: v.ticket_origen })]) : '',
    h('div', { class: 'tk-sep' }),
    h('ul', { class: 'vl-condiciones' }, condiciones.map((c) => h('li', { text: c }))),
  ]);
}

export const imprimirVale = (v) => imprimir(valeImpresoDom(v));
