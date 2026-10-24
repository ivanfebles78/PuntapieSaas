import { api } from '../api.js';
import { h } from '../dom.js';
import { API, badge, claseVto, DIAS_URGENTE, esUrgente, esVencido, etiquetaVto, eur, fecha, fileLink, hoy, normalizarRef } from './util.js';

const ESTADOS = Object.freeze([['', 'Todas'], ['pendiente', 'Pendientes'], ['vencida', 'Vencidas'], ['parcial', 'Parciales'], ['pagada', 'Pagadas']]);

function stat(label, value, sub, tone) {
  return h('div', { class: `pstat pstat-${tone}` }, [
    h('span', { class: 'pstat-label', text: label }),
    h('span', { class: 'pstat-value', text: value }),
    h('span', { class: 'pstat-sub', text: sub }),
  ]);
}

function stats(resumen, prevision) {
  const hoyIso = hoy();
  const urgentes = [...prevision.meses[0].items, ...prevision.posteriores.items].filter((v) => esUrgente({ ...v, pago: null }, hoyIso));
  const urgenteCent = urgentes.reduce((s, v) => s + v.importe_cent, 0);
  const e = resumen.por_estado;
  return h('div', { class: 'pstats' }, [
    stat('Pendiente de pago', eur(resumen.pendiente_cent), `${e.pendiente + e.parcial + e.vencida} facturas sin liquidar`, 'warn'),
    stat(`Vence en ${DIAS_URGENTE} días`, eur(urgenteCent), `${urgentes.length} vencimiento(s) · recuadro rojo`, 'urgente'),
    stat('Vencido', eur(resumen.vencido_cent), `${e.vencida} facturas vencidas · recuadro morado`, 'vencido'),
    stat('Pagado', eur(resumen.pagado_cent), `${e.pagada} de ${resumen.facturas} facturas pagadas${e.parcial ? ` · ${e.parcial} a medias` : ''}`, 'ok'),
    stat('Pedidos abiertos', String(resumen.pedidos_abiertos), 'sin factura ni recepción', 'info'),
  ]);
}

/** Pedidos registrados como enlace; referencias que solo cita el PDF, en gris. */
function celdaPedidos(d, ctx) {
  const enlazados = d.pedidos_asociados ?? [];
  const sueltas = d.pedidos.filter((ref) => !enlazados.some((p) => normalizarRef(p.numero) === normalizarRef(ref)));
  if (!enlazados.length && !sueltas.length) return '—';
  return h('span', { class: 'refs' }, [
    ...enlazados.map((p) => h('button', { type: 'button', class: 'ref-link', title: `Pedido registrado: ${fecha(p.fecha)} · ${eur(p.total_cent)}`, text: p.numero, 'data-open': String(p.id) })),
    ...sueltas.map((r) => h('span', { class: 'ref-loose', title: 'Citado en la factura, sin pedido registrado', text: r })),
  ]);
}

function vtos(d, hoyIso) {
  return h('div', { class: 'vtos' }, d.vencimientos.map((v) => h('span', { class: `vto ${claseVto(v, hoyIso)}` }, [
    h('span', { text: `${fecha(v.fecha)} · ${eur(v.importe_cent)}` }),
    esUrgente(v, hoyIso) || esVencido(v, hoyIso) ? h('em', { class: 'vto-dias', text: etiquetaVto(v, hoyIso) }) : null,
  ])));
}

function tabla(docs, ctx) {
  if (!docs.length) {
    return h('div', { class: 'pempty' }, [h('h3', { text: 'No hay facturas que mostrar' }), h('p', { text: 'Importa un PDF desde «Importar PDF» o cambia los filtros.' })]);
  }
  const hoyIso = hoy();
  return h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable' }, [
    h('thead', {}, h('tr', {}, ['Proveedor', 'Nº factura', 'Fecha', 'Total', 'Vencimientos', 'Pedido', 'Albarán', 'Entrega', 'Estado', ''].map((t, i) => h('th', { scope: 'col', class: i === 3 ? 'num' : null, text: t })))),
    h('tbody', {}, docs.map((d) => h('tr', {
      class: `prow${d.vencimientos.some((v) => esVencido(v, hoyIso)) ? ' is-vencida' : d.vencimientos.some((v) => esUrgente(v, hoyIso)) ? ' is-urgente' : ''}`,
      'data-doc': String(d.id),
      tabindex: '0',
    }, [
      h('td', { class: 'strong', text: d.proveedor.nombre }),
      h('td', { class: 'mono', text: d.numero }),
      h('td', { class: 'mono', text: fecha(d.fecha) }),
      h('td', { class: 'num strong', text: eur(d.total_cent) }),
      h('td', {}, vtos(d, hoyIso)),
      h('td', { class: 'mono small' }, celdaPedidos(d, ctx)),
      h('td', { class: 'mono small', text: d.albaranes.join(', ') || '—' }),
      h('td', { class: 'mono', text: fecha(d.fecha_entrega) }),
      h('td', {}, badge(d.estado)),
      h('td', {}, d.archivo ? fileLink(`${API}/documentos/${d.id}/archivo`, 'PDF', 'pbtn-ghost') : null),
    ]))),
  ]));
}

function totales(docs) {
  if (!docs.length) return null;
  const suma = (fn) => docs.reduce((s, d) => s + fn(d), 0);
  const pendiente = suma((d) => d.pendiente_cent);
  return h('div', { class: 'ptotals' }, [
    h('span', { text: `${docs.length} factura${docs.length === 1 ? '' : 's'}` }),
    h('span', {}, ['Total ', h('strong', { text: eur(suma((d) => d.total_cent)) })]),
    h('span', { class: 'is-paid' }, ['Pagado ', h('strong', { text: eur(suma((d) => d.pagado_cent)) })]),
    h('span', { class: pendiente > 0 ? 'is-pending' : null }, ['Pendiente ', h('strong', { text: eur(pendiente) })]),
  ]);
}

export async function renderFacturas(ctx, params = {}) {
  const filtros = { estado: params.estado ?? '', q: params.q ?? '', proveedor_id: params.proveedor_id ?? '' };
  const [resumen, proveedores, prevision] = await Promise.all([
    api('GET', `${API}/resumen`), api('GET', `${API}/lista`), api('GET', `${API}/prevision?meses=1`),
  ]);
  if (!resumen.ok) return void ctx.body.replaceChildren(h('p', { class: 'notice', text: resumen.error }));

  const search = h('input', { type: 'search', class: 'pinput grow', placeholder: 'Buscar por número, proveedor, pedido o albarán…', value: filtros.q });
  const select = h('select', { class: 'pinput', 'aria-label': 'Proveedor' }, [
    h('option', { value: '', text: 'Todos los proveedores' }),
    ...proveedores.data.map((p) => h('option', { value: String(p.id), text: p.nombre, selected: String(p.id) === String(filtros.proveedor_id) })),
  ]);
  const chips = h('div', { class: 'pchips', role: 'group', 'aria-label': 'Estado' }, ESTADOS.map(([v, t]) => h('button', {
    type: 'button', class: 'pchip', 'aria-pressed': String(filtros.estado === v), 'data-estado': v, text: t,
  })));
  const tablaBox = h('div', {}, h('p', { class: 'mgr-loading', text: 'Cargando…' }));
  const totalesBox = h('div');

  ctx.body.replaceChildren(
    h('div', { class: 'phead' }, [
      h('div', {}, [h('h3', { text: 'Facturas' }), h('p', { text: 'Todas las facturas de proveedores con sus vencimientos. Pulsa una fila para ver el detalle, pagar o adjuntar el justificante.' })]),
      h('div', { class: 'pbtn-row' }, [
        h('a', { class: 'pbtn', href: `${API}/export.csv?tipo=factura`, text: 'Exportar CSV' }),
        h('button', { class: 'pbtn', type: 'button', 'data-go': 'prevision', text: 'Calendario' }),
        h('button', { class: 'pbtn pbtn-primary', type: 'button', 'data-go': 'importar', 'data-write': '', text: '＋ Importar PDF' }),
      ]),
    ]),
    stats(resumen.data, prevision.data),
    h('div', { class: 'ptoolbar' }, [search, select, chips]),
    tablaBox,
    totalesBox,
  );

  const reload = () => ctx.go('facturas', { ...filtros });
  search.addEventListener('change', () => { filtros.q = search.value.trim(); reload(); });
  select.addEventListener('change', () => { filtros.proveedor_id = select.value; reload(); });
  ctx.body.querySelector('.phead').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) ctx.go(go.dataset.go);
  });
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-estado]');
    if (chip) { filtros.estado = chip.dataset.estado; reload(); }
  });

  const query = new URLSearchParams(Object.entries({ tipo: 'factura', ...filtros }).filter(([, v]) => v));
  const docs = await api('GET', `${API}/documentos?${query}`);
  if (!docs.ok) return void tablaBox.replaceChildren(h('p', { class: 'notice', text: docs.error }));
  tablaBox.replaceChildren(tabla(docs.data, ctx));
  totalesBox.replaceChildren(totales(docs.data) ?? '');
  const params2 = { ...filtros };
  tablaBox.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const ref = e.target.closest('[data-open]');
    if (ref) return void ctx.openDoc(Number(ref.dataset.open), { view: 'facturas', params: params2 });
    const row = e.target.closest('[data-doc]');
    if (row) ctx.openDoc(Number(row.dataset.doc), { view: 'facturas', params: params2 });
  });
  tablaBox.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-doc]');
    if (row && e.key === 'Enter') ctx.openDoc(Number(row.dataset.doc), { view: 'facturas', params: params2 });
  });
}
