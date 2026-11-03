import { api } from '../api.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Página del enlace del WhatsApp: el Administrador ve lo que se pide (un
// descuento o un cierre de caja que no cuadra) y lo aprueba o rechaza desde el móvil.

const ESTADO = Object.freeze({
  aprobado: 'Aprobado: la caja ya puede seguir.',
  rechazado: 'Rechazado: la caja no podrá hacerlo.',
  usado: 'Ya se ha usado.',
  caducado: 'La solicitud ha caducado (pasaron más de 30 minutos).',
});

function tarjeta(s) {
  if (s.tipo === 'cierre') {
    // En un cierre: subtotal = lo que debe haber; total = lo contado.
    const d = s.total_cent - s.subtotal_cent;
    return h('div', { class: 'apr-venta' }, [
      h('p', { class: 'apr-quien', text: `${s.solicitante} quiere cerrar la caja con un descuadre · ${s.creada}` }),
      h('ul', { class: 'apr-lineas' }, [
        h('li', {}, [h('span', { text: 'Debe haber' }), h('span', { text: formatEuros(s.subtotal_cent) })]),
        h('li', {}, [h('span', { text: 'Contado' }), h('span', { text: formatEuros(s.total_cent) })]),
      ]),
      h('p', { class: 'apr-total' }, [h('strong', { text: `${d > 0 ? 'Sobran' : 'Faltan'} ${formatEuros(Math.abs(d))}` })]),
    ]);
  }
  return h('div', { class: 'apr-venta' }, [
    h('p', { class: 'apr-quien', text: `${s.solicitante} pide un ${String(s.pct).replace('.', ',')} % de descuento · ${s.creada}` }),
    h('ul', { class: 'apr-lineas' }, s.lineas.map((l) => h('li', {}, [
      h('span', { text: `${l.cantidad} × ${l.descripcion}${l.talla && l.talla !== 'Única' ? ` · T. ${l.talla}` : ''}` }),
      h('span', { text: formatEuros(l.total_cent) }),
    ]))),
    h('p', { class: 'apr-total' }, [h('s', { text: formatEuros(s.subtotal_cent) }), ' → ', h('strong', { text: formatEuros(s.total_cent) })]),
  ]);
}

export async function renderAprobar(zona, { token, user }) {
  const caja = h('section', { class: 'apr', 'aria-live': 'polite' }, h('p', { text: 'Cargando la solicitud…' }));
  zona.replaceChildren(caja);
  if (user.role !== 'admin') return void caja.replaceChildren(h('p', { class: 'apr-error', text: 'Solo un Administrador puede aprobarlo.' }));
  const res = await api('GET', `/api/tpv/aprobar/${encodeURIComponent(token)}`);
  if (!res.ok) return void caja.replaceChildren(h('p', { class: 'apr-error', text: res.error }));

  function pintar(s, mensaje = null) {
    const pendiente = s.estado === 'pendiente';
    caja.replaceChildren(
      h('h1', { class: 'apr-titulo', tabindex: '-1', text: s.tipo === 'cierre' ? 'Aprobar cierre de caja' : 'Aprobar descuento' }),
      tarjeta(s),
      pendiente
        ? h('div', { class: 'apr-botones' }, [
          h('button', { type: 'button', class: 'apr-si', 'data-decision': 'aprobar', text: 'Aprobar' }),
          h('button', { type: 'button', class: 'apr-no', 'data-decision': 'rechazar', text: 'Rechazar' }),
        ])
        : h('p', { class: `apr-estado is-${s.estado}`, text: ESTADO[s.estado] ?? s.estado }),
      mensaje ? h('p', { class: 'apr-error', text: mensaje }) : '',
    );
  }
  caja.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-decision]');
    if (!b) return;
    caja.querySelectorAll('[data-decision]').forEach((x) => { x.disabled = true; });
    const r = await api('POST', `/api/tpv/aprobar/${encodeURIComponent(token)}`, { decision: b.dataset.decision });
    if (r.ok) pintar(r.data);
    else pintar(res.data, r.error);
  });
  pintar(res.data);
  caja.querySelector('h1')?.focus();
}
