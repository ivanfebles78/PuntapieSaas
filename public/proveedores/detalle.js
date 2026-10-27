import { api } from '../api.js';
import { field, openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showToast } from '../toast.js';
import {
  API, badge, centToEur, claseVto, cobroTag, elegirArchivos, esUrgente, esVencido, etiquetaVto, eur, eurToCent, fecha, fileLink, hoy,
  normalizarRef, soloConsulta, subir, writeBtn,
} from './util.js';

const JUSTIFICANTE_ACCEPT = '.pdf,application/pdf,image/jpeg,image/png,image/webp';

/* ---------- Piezas ---------- */

function head(d, ctx, params) {
  return h('div', { class: 'pdetail-head' }, [
    h('button', { class: 'back pback', type: 'button', 'data-back': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: params.back?.view === 'pedidos' ? 'Pedidos' : params.back?.view === 'prevision' ? 'Previsión' : 'Facturas' }),
    ]),
    h('div', { class: 'pbadges' }, [badge(d.tipo), badge(d.estado), d.tipo === 'factura' ? cobroTag(d.proveedor.domiciliado) : null, d.confianza ? badge(`conf-${d.confianza}`) : null]),
    h('h3', { class: 'pdetail-title', text: `${d.proveedor.nombre} · ${d.numero}` }),
    h('p', { class: 'pmuted', text: [d.proveedor.cif ? `CIF ${d.proveedor.cif}` : null, `Emitida el ${fecha(d.fecha)}`, d.parser ? `leída con «${d.parser}»` : null].filter(Boolean).join(' · ') }),
  ]);
}

function stats(d) {
  return h('div', { class: 'pstats pstats-2' }, [
    h('div', { class: 'pstat' }, [h('span', { class: 'pstat-label', text: 'Total' }), h('span', { class: 'pstat-value', text: eur(d.total_cent) })]),
    d.tipo === 'factura' ? h('div', { class: `pstat pstat-${d.pendiente_cent > 0 ? 'warn' : 'ok'}` }, [
      h('span', { class: 'pstat-label', text: 'Pendiente' }),
      h('span', { class: 'pstat-value', text: eur(d.pendiente_cent) }),
      h('span', { class: 'pstat-sub', text: `pagado ${eur(d.pagado_cent)}` }),
    ]) : null,
  ]);
}

/** Justificantes distintos (un mismo archivo puede cubrir varios vencimientos). */
function justificantes(d) {
  const vistos = new Set();
  return d.vencimientos.filter((v) => v.pago?.archivo && !vistos.has(v.pago.archivo) && vistos.add(v.pago.archivo)).map((v) => v.pago);
}

function archivos(d) {
  const just = justificantes(d);
  return h('section', { class: 'psection' }, [
    h('h4', { class: 'psection-title', text: 'Archivos' }),
    h('div', { class: 'pfile-row' }, [
      h('span', { class: 'pfile-kind', text: `${d.tipo === 'factura' ? 'Factura' : 'Pedido'} (PDF)` }),
      h('div', { class: 'pbtn-row' }, [
        d.archivo ? fileLink(`${API}/documentos/${d.id}/archivo`, d.archivo_nombre ?? 'Ver PDF') : h('span', { class: 'pmuted', text: 'Sin archivo' }),
        d.archivo ? h('a', { class: 'pbtn pbtn-sm pbtn-ghost', href: `${API}/documentos/${d.id}/archivo?descargar=1`, text: 'Descargar' }) : null,
        writeBtn(d.archivo ? 'Sustituir' : 'Subir PDF', { 'data-adjuntar': '' }, `pbtn-sm ${d.archivo ? 'pbtn-ghost' : 'pbtn-primary'}`),
      ]),
    ]),
    d.tipo === 'factura' ? h('div', { class: 'pfile-row' }, [
      h('span', { class: 'pfile-kind', text: 'Justificante de pago' }),
      h('div', { class: 'pbtn-row' }, [
        ...(just.length ? just.map((p) => fileLink(`${API}/pagos/${p.id}/archivo`, p.archivo_nombre)) : [h('span', { class: 'pmuted', text: d.pagado_cent > 0 ? 'Pagada sin justificante' : 'Sin justificante' })]),
        writeBtn(just.length ? 'Subir otro' : d.pendiente_cent > 0 ? 'Subir justificante y marcar pagada' : 'Subir justificante', { 'data-justificante': '' },
          `pbtn-sm ${just.length ? 'pbtn-ghost' : 'pbtn-primary'}`),
      ]),
    ]) : null,
  ]);
}

function vencimientos(d) {
  const hoyIso = hoy();
  return h('section', { class: 'psection' }, [
    h('h4', { class: 'psection-title', text: 'Vencimientos y pagos' }),
    h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable pvto-table' }, [
      h('thead', {}, h('tr', {}, ['Vence', 'Importe', 'Estado', 'Pago', 'Justificante', ''].map((t, i) => h('th', { class: i === 1 ? 'num' : null, text: t })))),
      h('tbody', {}, d.vencimientos.map((v) => h('tr', { class: esVencido(v, hoyIso) ? 'is-vencida' : esUrgente(v, hoyIso) ? 'is-urgente' : null }, [
        h('td', {}, h('span', { class: `vto ${claseVto(v, hoyIso)}` }, [
          h('span', { text: fecha(v.fecha) }),
          esUrgente(v, hoyIso) || esVencido(v, hoyIso) ? h('em', { class: 'vto-dias', text: etiquetaVto(v, hoyIso) }) : null,
        ])),
        h('td', { class: 'num strong', text: eur(v.importe_cent) }),
        h('td', {}, badge(v.pago ? 'pagada' : v.fecha < hoyIso ? 'vencida' : 'pendiente')),
        h('td', { class: 'small', text: v.pago ? `${fecha(v.pago.fecha)}${v.pago.notas ? ` · ${v.pago.notas}` : ''}` : '—' }),
        h('td', {}, h('div', { class: 'pbtn-row' }, [
          v.pago?.archivo ? fileLink(`${API}/pagos/${v.pago.id}/archivo`, v.pago.archivo_nombre) : h('span', { class: 'pmuted', text: '—' }),
          v.pago ? writeBtn(v.pago.archivo ? 'Sustituir' : 'Adjuntar', { 'data-just-pago': String(v.pago.id) }, 'pbtn-sm pbtn-ghost') : null,
        ])),
        h('td', {}, v.pago
          ? writeBtn('Anular', { 'data-anular': String(v.pago.id) }, 'pbtn-sm pbtn-ghost')
          : writeBtn('Pagar', { 'data-pagar': String(v.id) }, 'pbtn-sm pbtn-primary')),
      ]))),
    ])),
    d.pendiente_cent > 0 ? h('div', { class: 'pbtn-row pmt' }, writeBtn('Marcar toda la factura como pagada', { 'data-pagar': '' }, 'pbtn-primary')) : null,
  ]);
}

function asociados(d) {
  const esFactura = d.tipo === 'factura';
  const enlazados = esFactura ? d.pedidos_asociados : d.facturas_asociadas;
  const etiqueta = esFactura ? 'Pedido' : 'Factura';
  const sueltas = esFactura ? d.pedidos.filter((ref) => !enlazados.some((p) => normalizarRef(p.numero) === normalizarRef(ref))) : [];
  return h('section', { class: 'psection' }, [
    h('h4', { class: 'psection-title', text: esFactura ? 'Pedido asociado' : 'Factura asociada' }),
    h('div', { class: 'pbtn-row' }, [
      ...(enlazados.length ? enlazados.map((o) => h('span', { class: 'passoc' }, [
        h('button', { type: 'button', class: 'pbtn pbtn-sm', 'data-open': String(o.id), text: `${etiqueta} ${o.numero} · ${fecha(o.fecha)} · ${eur(o.total_cent)}` }),
        writeBtn('×', { 'data-desasociar': String(o.id), title: 'Quitar asociación', 'aria-label': 'Quitar asociación' }, 'pbtn-sm pbtn-ghost'),
      ])) : [h('span', { class: 'pmuted', text: `Sin ${etiqueta.toLowerCase()} asociad${esFactura ? 'o' : 'a'}` })]),
      writeBtn(`＋ Asociar ${etiqueta.toLowerCase()}`, { 'data-asociar': '' }, `pbtn-sm ${enlazados.length ? '' : 'pbtn-primary'}`),
    ]),
    sueltas.length ? h('p', { class: 'pmuted small', text: `El documento cita el pedido ${sueltas.join(', ')}, pero no está registrado.` }) : null,
  ]);
}

function campo(label, input, wide = false) {
  return h('label', { class: `pfield${wide ? ' pfield-wide' : ''}` }, [h('span', { text: label }), input]);
}

function vtoRow(v) {
  return h('tr', {}, [
    h('td', {}, h('input', { type: 'date', name: 'vto_fecha', value: v.fecha })),
    h('td', {}, h('input', { type: 'text', class: 'num', name: 'vto_importe', value: centToEur(v.importe_cent), inputmode: 'decimal' })),
    h('td', {}, writeBtn('Quitar', { 'data-quitar': '' }, 'pbtn-sm pbtn-ghost')),
  ]);
}

function datos(d) {
  const esFactura = d.tipo === 'factura';
  const form = h('form', { class: 'pform', novalidate: true }, [
    h('fieldset', { class: 'pform-grid', disabled: soloConsulta() }, [
      campo('Tipo', h('select', { name: 'tipo' }, [h('option', { value: 'factura', text: 'Factura', selected: esFactura }), h('option', { value: 'pedido', text: 'Pedido', selected: !esFactura })])),
      campo('Número', h('input', { type: 'text', name: 'numero', value: d.numero, required: true })),
      campo('Fecha', h('input', { type: 'date', name: 'fecha', value: d.fecha ?? '' })),
      campo('Total (€)', h('input', { type: 'text', name: 'total', class: 'num', inputmode: 'decimal', value: centToEur(d.total_cent) })),
      campo('Forma de pago', h('input', { type: 'text', name: 'forma_pago', value: d.forma_pago ?? '' })),
      campo('Fecha de entrega', h('input', { type: 'date', name: 'fecha_entrega', value: d.fecha_entrega ?? '' })),
      campo('Pedidos citados', h('input', { type: 'text', name: 'pedidos', value: d.pedidos.join(', '), placeholder: 'Separados por comas' })),
      campo('Albaranes', h('input', { type: 'text', name: 'albaranes', value: d.albaranes.join(', '), placeholder: 'Separados por comas' })),
      !esFactura ? campo('Estado del pedido', h('select', { name: 'estado_manual' }, [
        h('option', { value: '', text: `Automático (${d.facturas_asociadas.length ? 'facturado' : 'pendiente'})` }),
        h('option', { value: 'recibido', text: 'Recibido', selected: d.estado_manual === 'recibido' }),
        h('option', { value: 'cancelado', text: 'Cancelado', selected: d.estado_manual === 'cancelado' }),
      ])) : null,
      campo('Notas', h('textarea', { name: 'notas', rows: '2', text: d.notas ?? '' }), true),
    ]),
    esFactura ? h('div', { class: 'pvto-edit' }, [
      h('h4', { class: 'psection-title', text: 'Editar vencimientos' }),
      h('p', { class: 'pmuted small', text: 'Los pagos se conservan si la fecha y el importe no cambian.' }),
      h('fieldset', { disabled: soloConsulta() }, h('table', { class: 'ptable pvto-edit-table' }, [
        h('thead', {}, h('tr', {}, ['Fecha', 'Importe (€)', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, d.vencimientos.map(vtoRow)),
      ])),
      writeBtn('＋ Añadir vencimiento', { 'data-add-vto': '' }, 'pbtn-sm'),
    ]) : null,
  ]);
  return h('section', { class: 'psection' }, [h('h4', { class: 'psection-title', text: 'Datos del documento' }), form]);
}

function leerFormulario(root, d) {
  const f = root.querySelector('.pform');
  const g = (n) => f.elements.namedItem(n)?.value ?? '';
  const body = {
    tipo: g('tipo'),
    numero: g('numero'),
    fecha: g('fecha') || null,
    total_cent: eurToCent(g('total')) ?? d.total_cent,
    forma_pago: g('forma_pago'),
    fecha_entrega: g('fecha_entrega') || null,
    pedidos: g('pedidos'),
    albaranes: g('albaranes'),
    notas: g('notas'),
    estado_manual: g('estado_manual') || null,
  };
  const filas = [...root.querySelectorAll('.pvto-edit-table tbody tr')];
  if (body.tipo === 'factura' && filas.length) {
    body.vencimientos = filas.map((tr) => ({
      fecha: tr.querySelector('[name=vto_fecha]').value,
      importe_cent: eurToCent(tr.querySelector('[name=vto_importe]').value) ?? 0,
    }));
  } else if (body.tipo === 'pedido') {
    body.vencimientos = [];
  }
  return body;
}

/* ---------- Acciones ---------- */

async function pagar(d, vencimientoId, archivoPrevio = null) {
  const total = vencimientoId ? d.vencimientos.find((v) => String(v.id) === vencimientoId)?.importe_cent : d.pendiente_cent;
  return openDialog({
    eyebrow: `${d.proveedor.nombre} · ${d.numero}`,
    title: vencimientoId ? `Pagar el vencimiento (${eur(total)})` : `Marcar toda la factura como pagada (${eur(total)})`,
    content: [
      field({ label: 'Fecha de pago', name: 'fecha', type: 'date', value: hoy(), required: true }),
      archivoPrevio
        ? h('p', { class: 'pmuted', text: `Justificante: ${archivoPrevio.name}` })
        : h('div', { class: 'field' }, [h('label', { text: 'Justificante (PDF o imagen, opcional)' }), h('input', { type: 'file', name: 'justificante', accept: JUSTIFICANTE_ACCEPT })]),
      field({ label: 'Notas', name: 'notas', autocomplete: 'off', hint: 'Referencia de la transferencia, banco…' }),
    ],
    submitLabel: 'Confirmar pago',
    onSubmit: async (form) => {
      const query = new URLSearchParams({ fecha: form.elements.namedItem('fecha').value, notas: form.elements.namedItem('notas').value });
      if (vencimientoId) query.set('vencimiento_id', vencimientoId);
      const file = archivoPrevio ?? form.elements.namedItem('justificante')?.files[0];
      const res = file
        ? await subir(`${API}/documentos/${d.id}/pagar?${query}`, file)
        : await api('POST', `${API}/documentos/${d.id}/pagar`, Object.fromEntries(query));
      return res.ok ? true : { error: res.error };
    },
  });
}

async function confirmar(title, lead, submitLabel) {
  return openDialog({ eyebrow: 'Confirmar', title, lead, submitLabel, tone: 'danger', onSubmit: async () => true });
}

async function elegirAsociado(d, ctx, params) {
  const esFactura = d.tipo === 'factura';
  const tipoOtro = esFactura ? 'pedido' : 'factura';
  const ya = new Set((esFactura ? d.pedidos_asociados : d.facturas_asociadas).map((o) => o.id));
  const res = await api('GET', `${API}/documentos?tipo=${tipoOtro}&proveedor_id=${d.proveedor.id}`);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  const candidatos = res.data.filter((o) => !ya.has(o.id));
  const chosen = await openDialog({
    eyebrow: `Asociar ${tipoOtro}`,
    title: `${tipoOtro === 'pedido' ? 'Pedidos' : 'Facturas'} de ${d.proveedor.nombre}`,
    lead: candidatos.length ? 'Elige cuál corresponde a este documento.' : `No hay ${tipoOtro}s de este proveedor sin asociar. Impórtalo primero o escribe la referencia en «Pedidos citados».`,
    content: candidatos.length ? h('div', { class: 'export-options' }, candidatos.map((o, i) => h('label', { class: 'export-option' }, [
      h('input', { type: 'radio', name: 'otro', value: String(o.id), checked: i === 0 }),
      h('span', { class: 'export-option-text' }, [h('strong', { text: o.numero }), h('small', { text: `${fecha(o.fecha)} · ${eur(o.total_cent)}${tipoOtro === 'pedido' ? ` · entrega ${fecha(o.fecha_entrega)}` : ''}` })]),
    ]))) : [],
    submitLabel: 'Asociar',
    onSubmit: async (form) => {
      if (!candidatos.length) return true;
      const r = await api('POST', `${API}/documentos/${d.id}/asociar`, { otro_id: Number(form.elements.namedItem('otro').value) });
      return r.ok ? 'asociado' : { error: r.error };
    },
  });
  if (chosen === 'asociado') {
    ctx.markChanged();
    showToast(tipoOtro === 'pedido' ? 'Pedido asociado.' : 'Factura asociada.');
    ctx.go('detalle', params);
  }
}

function bind(root, d, ctx, params) {
  const reload = () => ctx.go('detalle', params);
  const done = (msg) => { ctx.markChanged(); showToast(msg); reload(); };
  const fail = (res) => showToast(res.error, { tone: 'error' });

  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-back]')) return void ctx.back(params);
    const open = t.closest('[data-open]');
    if (open) return void ctx.openDoc(Number(open.dataset.open), params.back);
    const pay = t.closest('[data-pagar]');
    if (pay) {
      if (await pagar(d, pay.dataset.pagar || null)) done('Pago registrado.');
      return undefined;
    }
    const anular = t.closest('[data-anular]');
    if (anular) {
      if (!(await confirmar('¿Anular este pago?', 'El vencimiento vuelve a estar pendiente. Si el justificante no lo usa otro pago, se borra.', 'Anular pago'))) return undefined;
      const res = await api('DELETE', `${API}/pagos/${anular.dataset.anular}`);
      return void (res.ok ? done('Pago anulado.') : fail(res));
    }
    if (t.closest('[data-adjuntar]')) {
      const [file] = await elegirArchivos({ accept: '.pdf,application/pdf' });
      if (!file) return undefined;
      const res = await subir(`${API}/documentos/${d.id}/adjuntar`, file);
      return void (res.ok ? done('PDF guardado.') : fail(res));
    }
    if (t.closest('[data-justificante]')) {
      const [file] = await elegirArchivos({ accept: JUSTIFICANTE_ACCEPT });
      if (!file) return undefined;
      // Con vencimientos pendientes, subir el justificante es pagar toda la factura.
      if (d.pendiente_cent > 0) {
        if (await pagar(d, null, file)) done('Factura pagada con su justificante.');
        return undefined;
      }
      const res = await subir(`${API}/documentos/${d.id}/justificante`, file);
      return void (res.ok ? done('Justificante guardado.') : fail(res));
    }
    const justPago = t.closest('[data-just-pago]');
    if (justPago) {
      const [file] = await elegirArchivos({ accept: JUSTIFICANTE_ACCEPT });
      if (!file) return undefined;
      const res = await subir(`${API}/pagos/${justPago.dataset.justPago}/justificante`, file);
      return void (res.ok ? done('Justificante guardado.') : fail(res));
    }
    if (t.closest('[data-asociar]')) return void elegirAsociado(d, ctx, params);
    const desasociar = t.closest('[data-desasociar]');
    if (desasociar) {
      const [facturaId, pedidoId] = d.tipo === 'factura' ? [d.id, desasociar.dataset.desasociar] : [desasociar.dataset.desasociar, d.id];
      const res = await api('DELETE', `${API}/documentos/${facturaId}/asociar/${pedidoId}`);
      return void (res.ok ? done('Asociación quitada.') : fail(res));
    }
    if (t.closest('[data-add-vto]')) {
      root.querySelector('.pvto-edit-table tbody').append(vtoRow({ fecha: hoy(), importe_cent: 0 }));
      return undefined;
    }
    const quitar = t.closest('[data-quitar]');
    if (quitar) return void quitar.closest('tr').remove();
    if (t.closest('[data-guardar]')) {
      const res = await api('PUT', `${API}/documentos/${d.id}`, leerFormulario(root, d));
      return void (res.ok ? done('Cambios guardados.') : fail(res));
    }
    if (t.closest('[data-borrar]')) {
      if (!(await confirmar(`¿Eliminar ${d.tipo} ${d.numero}?`, `De ${d.proveedor.nombre}. Se borrarán también sus pagos y archivos.`, 'Eliminar'))) return undefined;
      const res = await api('DELETE', `${API}/documentos/${d.id}`);
      if (!res.ok) return void fail(res);
      ctx.markChanged();
      showToast('Documento eliminado.');
      return void ctx.back(params);
    }
    return undefined;
  });
}

/** Detalle de una factura o pedido: pagos, justificantes, asociaciones y edición. */
export async function renderDetalle(ctx, params) {
  const res = await api('GET', `${API}/documentos/${params.id}`);
  if (!res.ok) return void ctx.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const d = res.data;
  const root = h('div', { class: 'pdetail' }, [
    head(d, ctx, params),
    stats(d),
    archivos(d),
    d.tipo === 'factura' ? vencimientos(d) : null,
    asociados(d),
    datos(d),
    h('div', { class: 'pdetail-foot', 'data-write': '' }, [
      writeBtn('Eliminar documento', { 'data-borrar': '' }, 'pbtn-danger'),
      writeBtn('Guardar cambios', { 'data-guardar': '' }, 'pbtn-primary'),
    ]),
  ]);
  bind(root, d, ctx, params);
  ctx.body.replaceChildren(root);
}
