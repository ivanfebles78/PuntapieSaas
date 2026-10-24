import { api } from '../api.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { showToast } from '../toast.js';
import { API, badge, centToEur, eur, eurToCent, fecha, hoy, subir } from './util.js';

// «Importar PDF»: suelta facturas y pedidos, se leen con el lector de cada
// proveedor (o el genérico / la IA), se revisan y se guardan. La cola se
// conserva mientras el gestor siga abierto.

const MAX_FILES = 30;
const MOTIVOS = Object.freeze({
  archivo: 'Este mismo PDF ya está en la aplicación',
  numero: 'Ya hay un documento con este número de este proveedor',
  importe: 'Ya hay un documento del mismo proveedor con la misma fecha e importe',
});

let cola = []; // { tempId, archivo_nombre, extraido, duplicado, texto, error, guardado, docId, forzado }

function campo(label, name, value, { type = 'text', cls = '', wide = false } = {}) {
  return h('label', { class: `pfield${wide ? ' pfield-wide' : ''}` }, [h('span', { text: label }), h('input', { type, name, value: value ?? '', class: cls })]);
}

function filaVto(v) {
  return h('div', { class: 'vto-row' }, [
    h('input', { type: 'date', name: 'vto_fecha', value: v.fecha, 'aria-label': 'Fecha de vencimiento' }),
    h('input', { type: 'text', name: 'vto_importe', class: 'num', inputmode: 'decimal', value: centToEur(v.importe_cent), placeholder: '0,00', 'aria-label': 'Importe' }),
    h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-quitar': '', text: 'Quitar' }),
  ]);
}

function tarjeta(r, i) {
  const head = (children, extra = '') => h('div', { class: `review-head ${extra}` }, children);
  if (r.error) {
    return h('article', { class: 'review is-error', 'data-i': String(i) }, [
      head([h('span', { class: 'review-file', text: r.archivo_nombre }), h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-descartar': String(i), text: 'Quitar' })]),
      h('p', { class: 'review-warn', text: r.error }),
    ]);
  }
  const e = r.extraido;
  if (r.guardado) {
    return h('article', { class: 'review is-saved', 'data-i': String(i) }, head([
      h('span', { class: 'review-file' }, [h('span', { text: r.archivo_nombre }), badge(e.tipo), h('span', { class: 'pmuted', text: e.numero ?? '' })]),
      h('span', { class: 'pbtn-row' }, [h('span', { class: 'sbadge sb-pagada', text: 'Guardado' }), h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-abrir': String(r.docId), text: 'Abrir' })]),
    ]));
  }
  if (r.duplicado) {
    const d = r.duplicado;
    return h('article', { class: 'review is-dup', 'data-i': String(i) }, [
      head([
        h('span', { class: 'review-file' }, [h('span', { text: r.archivo_nombre }), h('span', { class: 'sbadge sb-vencida', text: 'Ya importada' })]),
        h('span', { class: 'pbtn-row' }, [
          h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-abrir': String(d.id), text: 'Ver la que ya existe' }),
          h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-forzar': String(i), title: 'Solo si de verdad es otro documento', text: 'Guardar igualmente' }),
          h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-descartar': String(i), text: 'Descartar' }),
        ]),
      ]),
      h('p', { class: 'review-warn' }, [`${MOTIVOS[d.motivo] ?? 'Parece que ya está importado'}: `, h('strong', { text: `${d.proveedor} · ${d.numero}` }), d.fecha ? ` (${fecha(d.fecha)}).` : '.']),
    ]);
  }
  const form = h('form', { class: 'review-body', novalidate: true }, [
    r.forzado ? h('p', { class: 'review-warn', text: 'Marcado como documento distinto pese a parecer repetido. Comprueba número, fecha e importe.' }) : null,
    e.avisos.length ? h('ul', { class: 'review-avisos' }, e.avisos.map((a) => h('li', { text: a }))) : null,
    h('div', { class: 'pform-grid' }, [
      h('label', { class: 'pfield' }, [h('span', { text: 'Tipo' }), h('select', { name: 'tipo' }, [
        h('option', { value: 'factura', text: 'Factura', selected: e.tipo === 'factura' }),
        h('option', { value: 'pedido', text: 'Pedido', selected: e.tipo === 'pedido' }),
      ])]),
      campo('Proveedor', 'proveedor_nombre', e.proveedor.nombre, { wide: true }),
      campo('CIF', 'proveedor_cif', e.proveedor.cif, { cls: 'mono' }),
      campo('Número', 'numero', e.numero, { cls: 'mono' }),
      campo('Fecha', 'fecha', e.fecha, { type: 'date' }),
      campo('Total (€)', 'total', centToEur(e.total_cent), { cls: 'num' }),
      campo('Forma de pago', 'forma_pago', e.forma_pago),
      campo('Fecha de entrega', 'fecha_entrega', e.fecha_entrega, { type: 'date' }),
      campo('Pedido(s)', 'pedidos', e.pedidos.join(', '), { cls: 'mono' }),
      campo('Albarán(es)', 'albaranes', e.albaranes.join(', '), { cls: 'mono' }),
    ]),
    h('div', { class: `solo-factura${e.tipo === 'pedido' ? ' is-hidden' : ''}` }, [
      h('h4', { class: 'psection-title', text: `Vencimientos${e.total_cent != null ? ` · total ${eur(e.total_cent)}` : ''}` }),
      h('div', { class: 'vto-editor' }, [
        ...e.vencimientos.map(filaVto),
        h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-add-vto': '', text: '＋ Añadir vencimiento' }),
      ]),
    ]),
    r.texto ? h('details', { class: 'review-raw' }, [h('summary', { text: 'Ver texto extraído del PDF' }), h('pre', { text: r.texto })]) : null,
  ]);
  return h('article', { class: 'review', 'data-i': String(i) }, [
    head([
      h('span', { class: 'review-file' }, [h('span', { text: r.archivo_nombre }), badge(e.tipo), badge(`conf-${e.confianza}`), h('span', { class: 'pmuted small', text: `lector: ${e.parser}` })]),
      h('span', { class: 'pbtn-row' }, [
        h('button', { class: 'pbtn pbtn-sm pbtn-ghost', type: 'button', 'data-descartar': String(i), text: 'Descartar' }),
        h('button', { class: 'pbtn pbtn-sm pbtn-primary', type: 'button', 'data-guardar': String(i), text: 'Guardar' }),
      ]),
    ]),
    form,
  ]);
}

function pintar(review) {
  const nuevos = cola.filter((r) => !r.guardado && !r.error && !r.duplicado);
  const dups = cola.filter((r) => r.duplicado && !r.guardado);
  review.replaceChildren(
    dups.length || nuevos.length > 1 ? h('div', { class: 'review-summary pbtn-row' }, [
      dups.length ? h('span', { class: 'sbadge sb-vencida', text: `${dups.length} ya importad${dups.length === 1 ? 'o' : 'os'}` }) : null,
      nuevos.length ? h('span', { class: 'sbadge sb-pendiente', text: `${nuevos.length} nuev${nuevos.length === 1 ? 'o' : 'os'}` }) : null,
      dups.length ? h('button', { class: 'pbtn pbtn-sm', type: 'button', 'data-quitar-dups': '', text: 'Quitar los repetidos de la lista' }) : null,
      nuevos.length > 1 ? h('button', { class: 'pbtn pbtn-primary', type: 'button', 'data-guardar-todos': '', text: `Guardar los ${nuevos.length} nuevos` }) : null,
    ]) : '',
    ...cola.map(tarjeta),
  );
}

async function guardar(review, i, ctx) {
  const r = cola[i];
  const card = review.querySelector(`.review[data-i="${i}"]`);
  const f = card.querySelector('form');
  const g = (n) => f.elements.namedItem(n)?.value ?? '';
  const tipo = g('tipo');
  const body = {
    tempId: r.tempId,
    tipo,
    proveedor: { nombre: g('proveedor_nombre'), cif: g('proveedor_cif') },
    numero: g('numero'),
    fecha: g('fecha') || null,
    total_cent: eurToCent(g('total')),
    forma_pago: g('forma_pago'),
    fecha_entrega: g('fecha_entrega') || null,
    pedidos: g('pedidos'),
    albaranes: g('albaranes'),
    parser: r.extraido.parser,
    confianza: r.extraido.confianza,
    vencimientos: tipo === 'pedido' ? [] : [...card.querySelectorAll('.vto-row')].map((row) => ({
      fecha: row.querySelector('[name=vto_fecha]').value,
      importe_cent: eurToCent(row.querySelector('[name=vto_importe]').value) ?? 0,
    })),
  };
  if (body.total_cent == null) return void showToast('Indica el importe total.', { tone: 'error' });
  const res = await api('POST', `${API}/documentos`, body);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  cola[i] = { ...r, guardado: true, docId: res.data.id };
  ctx.markChanged();
  showToast(`${tipo === 'pedido' ? 'Pedido' : 'Factura'} ${res.data.numero} guardada.`);
  return void pintar(review);
}

export async function renderImportar(ctx) {
  const cfg = await api('GET', `${API}/config`);
  const lectores = cfg.ok ? cfg.data.parsers.map((p) => p.nombre).join(', ') : '';
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true });
  const drop = h('button', { class: 'dropzone', type: 'button', 'data-drop': '' }, [
    icon('docDown', 'ico ico-xl'),
    h('strong', { text: 'Suelta aquí los PDF' }),
    h('span', { class: 'pmuted', text: `o pulsa para elegirlos · facturas y pedidos, hasta ${MAX_FILES} a la vez` }),
  ]);
  const review = h('div', { class: 'review-list' });
  const root = h('div', {}, [
    h('div', { class: 'phead' }, h('div', {}, [
      h('h3', { text: 'Importar facturas y pedidos' }),
      h('p', { text: `Se reconocen automáticamente ${lectores}${cfg.data?.ia ? ' y cualquier otro proveedor mediante IA' : '; para otros proveedores se hace una lectura aproximada que debes revisar'}. Se avisa si un PDF ya está importado (mismo archivo, mismo número o misma fecha e importe).` }),
    ])),
    drop,
    input,
    review,
  ]);

  async function analizar(files) {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')).slice(0, MAX_FILES);
    if (!pdfs.length) return void showToast('Solo se admiten archivos PDF.', { tone: 'error' });
    drop.setAttribute('aria-busy', 'true');
    let ok = 0;
    for (const [n, f] of pdfs.entries()) {
      drop.querySelector('strong').textContent = `Analizando ${n + 1} de ${pdfs.length}…`;
      const res = await subir(`${API}/analizar`, f);
      if (res.ok) ok += 1;
      cola = [res.ok ? { ...res.data, guardado: false } : { tempId: null, archivo_nombre: f.name, error: res.error }, ...cola];
      pintar(review);
    }
    drop.removeAttribute('aria-busy');
    drop.querySelector('strong').textContent = 'Suelta aquí más PDF';
    return void showToast(`${ok} documento(s) analizados. Revisa y guarda.`);
  }

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { analizar([...input.files]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); analizar([...e.dataTransfer.files]); });

  review.addEventListener('change', (e) => {
    if (e.target.name !== 'tipo') return;
    e.target.closest('.review').querySelector('.solo-factura').classList.toggle('is-hidden', e.target.value === 'pedido');
  });
  review.addEventListener('click', async (e) => {
    const t = e.target;
    const save = t.closest('[data-guardar]');
    if (save) return void guardar(review, Number(save.dataset.guardar), ctx);
    if (t.closest('[data-guardar-todos]')) {
      for (const [i, r] of cola.entries()) if (!r.guardado && !r.error && !r.duplicado) await guardar(review, i, ctx);
      return undefined;
    }
    const abrir = t.closest('[data-abrir]');
    if (abrir) return void ctx.openDoc(Number(abrir.dataset.abrir), { view: 'importar', params: {} });
    const forzar = t.closest('[data-forzar]');
    if (forzar) {
      const i = Number(forzar.dataset.forzar);
      cola = cola.map((r, j) => (j === i ? { ...r, duplicado: null, forzado: true } : r));
      return void pintar(review);
    }
    const descartar = t.closest('[data-descartar]');
    if (descartar) {
      const i = Number(descartar.dataset.descartar);
      if (cola[i].tempId) await api('DELETE', `${API}/analizar/${cola[i].tempId}`);
      cola = cola.filter((_, j) => j !== i);
      return void pintar(review);
    }
    if (t.closest('[data-quitar-dups]')) {
      for (const r of cola.filter((x) => x.duplicado && !x.guardado && x.tempId)) await api('DELETE', `${API}/analizar/${r.tempId}`);
      cola = cola.filter((r) => !r.duplicado || r.guardado);
      return void pintar(review);
    }
    if (t.closest('[data-add-vto]')) return void t.closest('[data-add-vto]').before(filaVto({ fecha: hoy(), importe_cent: 0 }));
    const quitar = t.closest('[data-quitar]');
    if (quitar) quitar.closest('.vto-row').remove();
    return undefined;
  });

  pintar(review);
  ctx.body.replaceChildren(root);
}
