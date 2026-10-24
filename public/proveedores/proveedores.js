import { api } from '../api.js';
import { h } from '../dom.js';
import { showToast } from '../toast.js';
import { API, elegirArchivos, eur, soloConsulta, subir, writeBtn } from './util.js';

function importBlock(ctx) {
  const status = h('p', { class: 'pmuted small', 'aria-live': 'polite' });
  const block = h('section', { class: 'psection pimport-legacy', 'data-write': '' }, [
    h('h4', { class: 'psection-title', text: 'Traer los datos de «Control de facturas»' }),
    h('p', { class: 'pmuted', text: 'Sube el ZIP exportado de la app antigua (datos/datos.json con sus PDF y justificantes). Se puede repetir: lo que ya está no se duplica.' }),
    h('div', { class: 'pbtn-row' }, writeBtn('Subir ZIP de la app antigua…', { 'data-import-zip': '' }, 'pbtn-primary')),
    status,
  ]);
  block.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-import-zip]')) return;
    const [file] = await elegirArchivos({ accept: '.zip,application/zip' });
    if (!file) return;
    status.textContent = `Importando «${file.name}»… puede tardar un poco.`;
    const res = await subir(`${API}/importar-zip`, file);
    if (!res.ok) {
      status.textContent = '';
      return void showToast(res.error, { tone: 'error' });
    }
    const r = res.data;
    ctx.markChanged();
    status.textContent = [
      `Importado: ${r.facturas} facturas, ${r.pedidos} pedidos, ${r.vencimientos} vencimientos y ${r.pagos} pagos de ${r.proveedores} proveedores (${r.archivos} archivos).`,
      r.yaEstaban ? `${r.yaEstaban} ya estaban.` : null,
      r.reparados.length ? `${r.reparados.length} PDF venían con cabeceras de la descarga y se han limpiado.` : null,
      r.cuadra === true ? 'Los totales cuadran con la app antigua.' : r.cuadra === false ? 'Atención: los totales NO cuadran con el resumen de la app antigua.' : null,
    ].filter(Boolean).join(' ');
    showToast(r.cuadra === false ? 'Importado, pero los totales no cuadran: revísalo.' : 'Datos importados.', { tone: r.cuadra === false ? 'error' : undefined });
  });
  return block;
}

/** Proveedores: se crean solos al importar (por CIF); aquí se renombran. */
export async function renderProveedores(ctx) {
  const res = await api('GET', `${API}/lista`);
  if (!res.ok) return void ctx.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const ro = soloConsulta();
  const root = h('div', {}, [
    h('div', { class: 'phead' }, h('div', {}, [
      h('h3', { text: 'Proveedores' }),
      h('p', { text: 'Se crean solos al importar documentos (por CIF). Puedes cambiar el nombre con el que aparecen.' }),
    ])),
    res.data.length ? h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable' }, [
      h('thead', {}, h('tr', {}, ['Nombre', 'CIF', 'Facturas', 'Pedidos', 'Facturado', 'Pendiente', ''].map((t, i) => h('th', { class: i >= 2 && i <= 5 ? 'num' : null, text: t })))),
      h('tbody', {}, res.data.map((p) => h('tr', { 'data-id': String(p.id) }, [
        h('td', {}, h('input', { type: 'text', class: 'pinput', name: 'nombre', value: p.nombre, disabled: ro, 'aria-label': 'Nombre' })),
        h('td', {}, h('input', { type: 'text', class: 'pinput mono pinput-cif', name: 'cif', value: p.cif ?? '', disabled: ro, 'aria-label': 'CIF' })),
        h('td', { class: 'num' }, h('button', { type: 'button', class: 'ref-link', 'data-facturas': String(p.id), text: String(p.facturas) })),
        h('td', { class: 'num', text: String(p.pedidos) }),
        h('td', { class: 'num', text: eur(p.facturado_cent) }),
        h('td', { class: `num ${p.pendiente_cent > 0 ? 'strong' : 'pmuted'}`, text: eur(p.pendiente_cent) }),
        h('td', {}, writeBtn('Guardar', { 'data-guardar': String(p.id) }, 'pbtn-sm')),
      ]))),
    ])) : h('div', { class: 'pempty' }, [h('h3', { text: 'Sin proveedores todavía' }), h('p', { text: 'Aparecerán al importar la primera factura.' })]),
    ctx.user?.role === 'admin' ? importBlock(ctx) : null,
    h('p', { class: 'pmuted small pmt', text: 'Copia de seguridad: «Exportar» en la tabla de Gastos descarga un ZIP con el Excel y todos los PDF y justificantes, también los de proveedores.' }),
  ]);
  root.addEventListener('click', async (e) => {
    const fact = e.target.closest('[data-facturas]');
    if (fact) return void ctx.go('facturas', { proveedor_id: fact.dataset.facturas });
    const save = e.target.closest('[data-guardar]');
    if (!save) return undefined;
    const tr = save.closest('tr');
    const r = await api('PUT', `${API}/lista/${save.dataset.guardar}`, {
      nombre: tr.querySelector('[name=nombre]').value, cif: tr.querySelector('[name=cif]').value,
    });
    if (!r.ok) return void showToast(r.error, { tone: 'error' });
    ctx.markChanged();
    return void showToast('Proveedor actualizado.');
  });
  ctx.body.replaceChildren(root);
}
