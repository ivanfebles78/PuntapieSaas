import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { showToast } from '../toast.js';
import { API, cobroTag, elegirArchivos, esUrgente, etiquetaVto, eur, fecha, hoy, subir, writeBtn } from './util.js';

// Previsión de pagos: lo vencido y los meses siguientes, con el pago en cada línea.

const MESES = Object.freeze([3, 6, 12]);
const CALENDARIOS = Object.freeze([
  [3, 'Trimestre', 'Este mes y los dos siguientes'],
  [6, 'Medio año', 'Este mes y los cinco siguientes'],
  [9, 'Nueve meses', 'Este mes y los ocho siguientes'],
]);

function item(v, vencido = false) {
  const hoyIso = hoy();
  const urgente = !vencido && esUrgente({ ...v, pago: null }, hoyIso);
  return h('li', { class: `prev-item${vencido ? ' is-vencido' : ''}${urgente ? ' is-urgente' : ''}` }, [
    h('div', {}, [
      h('div', { class: 'prev-prov' }, [v.proveedor_nombre, ' ', cobroTag(v.domiciliado)]),
      h('div', { class: 'prev-ref', text: `Factura ${v.numero} · emitida ${fecha(v.documento_fecha)}` }),
    ]),
    h('div', { class: 'prev-importe' }, [
      h('div', { class: 'num strong', text: eur(v.importe_cent) }),
      h('div', { class: 'prev-fecha' }, [
        h('span', { text: `vence ${fecha(v.fecha)}` }),
        urgente || vencido ? h('em', { class: 'vto-dias', text: etiquetaVto({ ...v, pago: null }, hoyIso) }) : null,
      ]),
    ]),
    h('div', { class: 'prev-acciones pbtn-row' }, [
      writeBtn('✓ Con justificante', { 'data-pagar-con': String(v.id), 'data-doc': String(v.documento_id), title: 'Marcar pagado adjuntando el justificante' }, 'pbtn-sm pbtn-primary'),
      writeBtn('✓ Sin justificante', { 'data-pagar-sin': String(v.id), 'data-doc': String(v.documento_id) }, 'pbtn-sm'),
      h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-ver': String(v.documento_id), text: 'Ver factura' }),
    ]),
  ]);
}

async function elegirCalendario() {
  await openDialog({
    eyebrow: 'Calendario de pagos',
    title: 'Calendario en PDF',
    lead: 'Un mes por página, con los días marcados y el detalle de cada factura a pagar.',
    allowReadOnly: true,
    content: h('div', { class: 'export-options' }, CALENDARIOS.map(([n, titulo, desc]) => h('div', { class: 'export-option is-static' }, [
      h('span', { class: 'export-option-text' }, [h('strong', { text: titulo }), h('small', { text: desc })]),
      h('span', { class: 'pbtn-row' }, [
        h('a', { class: 'pbtn pbtn-sm', href: `${API}/calendario.pdf?meses=${n}&ver=1`, target: '_blank', rel: 'noopener', text: 'Ver' }),
        h('a', { class: 'pbtn pbtn-sm pbtn-primary', href: `${API}/calendario.pdf?meses=${n}`, text: 'Descargar' }),
      ]),
    ]))),
    submitLabel: 'Cerrar',
    cancelLabel: null,
    onSubmit: async () => true,
  });
}

export async function renderPrevision(ctx, params = {}) {
  const meses = MESES.includes(Number(params.meses)) ? Number(params.meses) : 3;
  const res = await api('GET', `${API}/prevision?meses=${meses}`);
  if (!res.ok) return void ctx.body.replaceChildren(h('p', { class: 'notice', text: res.error }));
  const p = res.data;

  const root = h('div', {}, [
    h('div', { class: 'phead' }, [
      h('div', {}, [
        h('h3', { text: 'Previsión de pagos' }),
        h('p', {}, ['Lo que queda por pagar, agrupado por mes de vencimiento. Total pendiente: ', h('strong', { text: eur(p.total_pendiente_cent) }), '.']),
      ]),
      h('div', { class: 'pbtn-row' }, [
        ...MESES.map((n) => h('button', { type: 'button', class: `pbtn${n === meses ? ' pbtn-primary' : ''}`, 'data-meses': String(n), text: `${n} meses` })),
        h('button', { type: 'button', class: 'pbtn pbtn-primary', 'data-calendario': '', text: 'Calendario en PDF' }),
      ]),
    ]),
    p.vencidos.items.length ? h('div', { class: 'prev-banner' }, [
      h('div', {}, [
        h('h4', { text: `Vencido y sin pagar: ${eur(p.vencidos.total_cent)}` }),
        h('p', { class: 'small', text: `${p.vencidos.items.length} vencimiento(s) con fecha anterior a hoy.` }),
      ]),
      h('ul', { class: 'prev-list' }, p.vencidos.items.map((v) => item(v, true))),
    ]) : null,
    h('div', { class: 'prev-cols' }, p.meses.map((m, i) => h('section', { class: `prev-col${i === 0 ? ' is-actual' : ''}` }, [
      h('div', { class: 'prev-head' }, [
        h('h4', { text: `${m.etiqueta}${i === 0 ? ' (este mes)' : ''}` }),
        h('span', { class: 'num strong', text: eur(m.total_cent) }),
      ]),
      m.items.length ? h('ul', { class: 'prev-list' }, m.items.map((v) => item(v))) : h('div', { class: 'prev-empty', text: 'Nada que pagar' }),
    ]))),
    p.posteriores.items.length ? h('div', { class: 'prev-more' }, [
      h('h4', { text: 'Más adelante' }),
      h('span', { class: 'num strong', text: eur(p.posteriores.total_cent) }),
      h('span', { class: 'pmuted small', text: `en ${p.posteriores.items.length} vencimiento(s) posteriores a ${p.meses.at(-1).etiqueta}` }),
    ]) : null,
  ]);

  const reload = () => ctx.go('prevision', { meses });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const n = t.closest('[data-meses]');
    if (n) return void ctx.go('prevision', { meses: Number(n.dataset.meses) });
    if (t.closest('[data-calendario]')) return void elegirCalendario();
    const ver = t.closest('[data-ver]');
    if (ver) return void ctx.openDoc(Number(ver.dataset.ver), { view: 'prevision', params: { meses } });
    const sin = t.closest('[data-pagar-sin]');
    if (sin) {
      const res = await api('POST', `${API}/documentos/${sin.dataset.doc}/pagar`, { vencimiento_id: sin.dataset.pagarSin });
      if (!res.ok) return void showToast(res.error, { tone: 'error' });
      ctx.markChanged();
      showToast('Marcado como pagado.');
      return void reload();
    }
    const con = t.closest('[data-pagar-con]');
    if (con) {
      const [file] = await elegirArchivos({ accept: '.pdf,application/pdf,image/jpeg,image/png,image/webp' });
      if (!file) return undefined;
      const res = await subir(`${API}/documentos/${con.dataset.doc}/pagar?vencimiento_id=${con.dataset.pagarCon}&fecha=${hoy()}`, file);
      if (!res.ok) return void showToast(res.error, { tone: 'error' });
      ctx.markChanged();
      showToast('Pago registrado con su justificante.');
      return void reload();
    }
    return undefined;
  });
  ctx.body.replaceChildren(root);
}
