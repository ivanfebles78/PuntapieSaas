import { h } from '../dom.js';
import { icon } from '../icons.js';
import { renderDetalle } from './detalle.js';
import { renderFacturas } from './facturas.js';
import { renderImportar } from './importar.js';
import { renderPedidos } from './pedidos.js';
import { renderPrevision } from './prevision.js';
import { renderProveedores } from './proveedores.js';

// «Gestionar pagos a proveedores»: todo lo que tenía «Control de facturas»
// (facturas, previsión, pedidos, proveedores e importar PDF) en un modal
// grande encima de la tabla de Gastos.

const TABS = Object.freeze([
  { id: 'facturas', label: 'Facturas', icon: 'receipt', render: renderFacturas },
  { id: 'prevision', label: 'Previsión', icon: 'calendar', render: renderPrevision },
  { id: 'pedidos', label: 'Pedidos', icon: 'box', render: renderPedidos },
  { id: 'proveedores', label: 'Proveedores', icon: 'truck', render: renderProveedores },
  { id: 'importar', label: 'Importar PDF', icon: 'docDown', render: renderImportar, write: true },
]);

/**
 * Abre el gestor. `view` = pestaña inicial; `docId` abre directamente el
 * detalle de una factura o pedido. Resuelve true si algo cambió (para que la
 * tabla de Gastos se recargue).
 */
export function openSupplierManager({ view = 'facturas', docId = null, user } = {}) {
  return new Promise((resolve) => {
    let changed = false;
    let current = { view, params: {} };
    const body = h('div', { class: 'mgr-body', 'aria-live': 'polite' });
    const tabs = h('nav', { class: 'mgr-tabs', 'aria-label': 'Secciones' }, TABS.map((t) => h('button', {
      type: 'button', class: 'mgr-tab', 'data-tab': t.id, ...(t.write ? { 'data-write': '' } : {}),
    }, [icon(t.icon, 'ico ico-xs'), h('span', { text: t.label })])));
    const close = h('button', { class: 'sheet-close mgr-close', type: 'button', 'aria-label': 'Cerrar' }, icon('close', 'ico ico-sm'));
    const dialog = h('dialog', { class: 'mgr' }, h('div', { class: 'mgr-core' }, [
      h('header', { class: 'mgr-head' }, [
        h('div', { class: 'mgr-title' }, [
          h('p', { class: 'eyebrow-pill', text: 'Gastos · Proveedores' }),
          h('h2', { text: 'Pagos a proveedores' }),
        ]),
        tabs,
        close,
      ]),
      body,
    ]));

    const ctx = {
      body,
      user,
      markChanged() { changed = true; },
      go(nextView, params = {}) {
        current = { view: nextView, params };
        tabs.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === nextView)));
        body.scrollTop = 0;
        // Cada vista pinta en su propio contenedor: si se cambia de pestaña
        // antes de que termine de cargar, la anterior pinta en uno ya retirado.
        const section = h('div', { class: 'mgr-view' }, h('p', { class: 'mgr-loading', text: 'Cargando…' }));
        body.replaceChildren(section);
        const viewCtx = { ...ctx, body: section };
        const tab = TABS.find((t) => t.id === nextView);
        return tab ? tab.render(viewCtx, params) : renderDetalle(viewCtx, params);
      },
      openDoc(id, back = current) {
        return ctx.go('detalle', { id, back });
      },
      back(params) {
        const target = params?.back ?? { view: 'facturas', params: {} };
        return ctx.go(target.view, target.params);
      },
    };

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(changed);
    };
    dialog.addEventListener('close', finish);
    close.addEventListener('click', finish);
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) ctx.go(tab.dataset.tab);
    });

    document.body.append(dialog);
    dialog.showModal();
    if (docId) ctx.openDoc(docId, { view, params: {} });
    else ctx.go(view);
  });
}
