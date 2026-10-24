import { api } from '../api.js';
import { h } from '../dom.js';
import { showToast } from '../toast.js';
import { API, badge, eur, fecha, fileLink, writeBtn } from './util.js';

const ESTADOS = Object.freeze([['', 'Todos'], ['pendiente', 'Pendientes'], ['facturado', 'Facturados'], ['recibido', 'Recibidos'], ['cancelado', 'Cancelados']]);

/** Pedidos a proveedores: pasan a «facturado» solos cuando llega una factura que cita su número. */
export async function renderPedidos(ctx, params = {}) {
  const estado = params.estado ?? '';
  const res = await api('GET', `${API}/documentos?tipo=pedido${estado ? `&estado=${estado}` : ''}`);
  if (!res.ok) return void ctx.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const docs = res.data;
  const abiertos = docs.filter((d) => d.estado === 'pendiente');

  const root = h('div', {}, [
    h('div', { class: 'phead' }, [
      h('div', {}, [h('h3', { text: 'Pedidos' }), h('p', { text: 'Pedidos realizados a proveedores. Un pedido pasa a «facturado» cuando llega una factura que cita su número.' })]),
      h('div', { class: 'pbtn-row' }, [
        h('a', { class: 'pbtn', href: `${API}/export.csv?tipo=pedido`, text: 'Exportar CSV' }),
        h('button', { class: 'pbtn pbtn-primary', type: 'button', 'data-importar': '', 'data-write': '', text: '＋ Importar PDF' }),
      ]),
    ]),
    h('div', { class: 'pstats pstats-2' }, [
      h('div', { class: 'pstat pstat-warn' }, [h('span', { class: 'pstat-label', text: 'Pendiente de facturar' }), h('span', { class: 'pstat-value', text: eur(abiertos.reduce((s, d) => s + d.total_cent, 0)) }), h('span', { class: 'pstat-sub', text: `${abiertos.length} pedidos abiertos` })]),
      h('div', { class: 'pstat pstat-info' }, [h('span', { class: 'pstat-label', text: 'Pedidos' }), h('span', { class: 'pstat-value', text: String(docs.length) })]),
    ]),
    h('div', { class: 'ptoolbar' }, h('div', { class: 'pchips' }, ESTADOS.map(([v, t]) => h('button', { type: 'button', class: 'pchip', 'aria-pressed': String(estado === v), 'data-estado': v, text: t })))),
    docs.length ? h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable' }, [
      h('thead', {}, h('tr', {}, ['Proveedor', 'Nº pedido', 'Fecha', 'Importe', 'Entrega prevista', 'Estado', 'Facturas', ''].map((t, i) => h('th', { class: i === 3 ? 'num' : null, text: t })))),
      h('tbody', {}, docs.map((d) => h('tr', { class: 'prow', 'data-doc': String(d.id), tabindex: '0' }, [
        h('td', { class: 'strong', text: d.proveedor.nombre }),
        h('td', { class: 'mono', text: d.numero }),
        h('td', { class: 'mono', text: fecha(d.fecha) }),
        h('td', { class: 'num strong', text: eur(d.total_cent) }),
        h('td', { class: 'mono', text: fecha(d.fecha_entrega) }),
        h('td', {}, badge(d.estado)),
        h('td', { class: 'small' }, d.facturas_asociadas.length
          ? h('span', { class: 'refs' }, d.facturas_asociadas.map((f) => h('button', { type: 'button', class: 'ref-link', 'data-open': String(f.id), text: f.numero })))
          : '—'),
        h('td', {}, h('div', { class: 'pbtn-row' }, [
          d.archivo ? fileLink(`${API}/documentos/${d.id}/archivo`, 'PDF', 'pbtn-ghost') : null,
          d.estado === 'pendiente' || d.estado === 'facturado' ? writeBtn('Recibido', { 'data-recibido': String(d.id) }, 'pbtn-sm') : null,
        ])),
      ]))),
    ])) : h('div', { class: 'pempty' }, [h('h3', { text: 'No hay pedidos' }), h('p', { text: 'Importa el PDF de un pedido desde «Importar PDF»: se detecta como pedido y no genera vencimientos.' })]),
  ]);

  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('a')) return undefined;
    if (t.closest('[data-importar]')) return void ctx.go('importar');
    const chip = t.closest('[data-estado]');
    if (chip) return void ctx.go('pedidos', { estado: chip.dataset.estado });
    const recibido = t.closest('[data-recibido]');
    if (recibido) {
      const r = await api('PUT', `${API}/documentos/${recibido.dataset.recibido}`, { estado_manual: 'recibido' });
      if (!r.ok) return void showToast(r.error, { tone: 'error' });
      ctx.markChanged();
      showToast('Pedido marcado como recibido.');
      return void ctx.go('pedidos', { estado });
    }
    const open = t.closest('[data-open]') ?? t.closest('[data-doc]');
    if (open) ctx.openDoc(Number(open.dataset.open ?? open.dataset.doc), { view: 'pedidos', params: { estado } });
    return undefined;
  });
  ctx.body.replaceChildren(root);
}
