import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Piezas comunes de la venta y de los cambios: la rejilla de modelos con sus
// tallas y la tarjeta de un vale escaneado.

/** Modelos encontrados con sus tallas (cada talla es un botón con data-g/data-t). */
export function modelosDom(modelos) {
  return modelos.map((m, gi) => h('article', { class: 'vt-modelo' }, [
    h('div', { class: 'vt-m-cab' }, [
      h('strong', { text: `${m.marca} · ${m.modelo}` }),
      h('span', { text: [m.referencia, m.color, m.detalle].filter(Boolean).join(' · ') }),
    ]),
    h('div', { class: 'vt-tallas' }, m.tallas.map((t, ti) => h('button', {
      type: 'button', class: `vt-talla${t.stock > 0 ? '' : ' is-agotada'}`, 'data-g': String(gi), 'data-t': String(ti),
      title: t.stock > 0 ? `${t.stock} en tienda` : 'Sin stock',
    }, [
      h('strong', { text: t.talla }),
      h('span', { text: t.pvp_cent != null ? formatEuros(t.pvp_cent) : 'sin PVP' }),
      h('small', { text: t.stock > 0 ? `${t.stock} ${t.stock === 1 ? 'ud.' : 'uds.'}` : 'agotada' }),
    ]))),
  ]));
}

/** El artículo de la talla pulsada (los modelos se guardan en `zona.dataset.modelos`). */
export function tallaPulsada(zona, boton) {
  const modelos = JSON.parse(zona.dataset.modelos ?? '[]');
  return modelos[Number(boton.dataset.g)]?.tallas[Number(boton.dataset.t)] ?? null;
}

const ESTADO_VALE = Object.freeze({ activo: 'Activo', agotado: 'Agotado', caducado: 'Caducado' });

/** Lo que se ve al escanear el QR de un vale. */
export function valeDom(v) {
  return h('article', { class: `vt-vale is-${v.estado}` }, [
    h('div', { class: 'vt-vale-cab' }, [h('strong', { text: `Vale ${v.codigo_legible}` }), h('span', { class: 'vt-vale-estado', text: ESTADO_VALE[v.estado] ?? v.estado })]),
    h('div', { class: 'vt-vale-cifras' }, [
      h('div', {}, [h('span', { text: 'Saldo' }), h('strong', { text: formatEuros(v.saldo_cent) })]),
      h('div', {}, [h('span', { text: 'Importe' }), h('strong', { text: formatEuros(v.importe_cent) })]),
      h('div', {}, [h('span', { text: 'Caduca' }), h('strong', { text: v.caduca })]),
    ]),
    h('p', { class: 'vt-vale-origen', text: `Emitido el ${v.emitido}${v.ticket_origen ? ` en ${v.ticket_origen.startsWith('R') ? 'la devolución' : 'el cambio'} ${v.ticket_origen}` : ''}.` }),
    v.usos.length
      ? h('ul', { class: 'vt-vale-usos' }, v.usos.map((u) => h('li', {}, [h('span', { text: `${u.fecha} · ticket ${u.ticket}` }), h('strong', { text: `−${formatEuros(u.importe_cent)}` })])))
      : h('p', { class: 'vt-vale-origen', text: 'Aún no se ha usado.' }),
    v.estado === 'activo' ? h('p', { class: 'vt-vale-origen', text: 'Para pagar con él: Cobrar › Vale y escanéalo.' }) : '',
  ]);
}
