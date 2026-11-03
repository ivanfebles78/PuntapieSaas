import { api } from '../api.js';
import { h } from '../dom.js';
import { showToast } from '../toast.js';
import { writeBtn } from './util.js';

// Bloque «Correo» de Importar PDF: cuándo se revisó el buzón, qué se registró
// solo y lo que queda para revisar (se abre aquí mismo como un PDF subido).

const API = '/api/correo';
const TIPO = Object.freeze({ proveedor: 'Proveedor', gasto: 'Gasto', desconocido: 'Sin reconocer' });

const cuando = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: 'Atlantic/Canary', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function lineaEstado(e) {
  if (!e.configurado) {
    return h('p', { class: 'pmuted', text: 'El correo no está conectado: falta añadir GMAIL_USER y GMAIL_APP_PASSWORD en Railway.' });
  }
  const u = e.ultima;
  const r = u?.resumen;
  return h('p', { class: 'pmuted' }, [
    `Se revisa ${e.cuenta} cada día a las ${e.hora}:00. `,
    !u ? 'Aún no se ha revisado.'
      : u.error ? h('strong', { class: 'texto-error', text: `La última revisión (${cuando(u.inicio)}) falló: ${u.error}` })
        : `Última revisión: ${cuando(u.fin ?? u.inicio)} · ${r?.proveedores ?? 0} facturas o pedidos, ${r?.gastos ?? 0} gastos, ${r?.revisar ?? 0} para revisar.`,
  ]);
}

function fila(p) {
  const acciones = [
    p.estado === 'productos' && p.documento_id ? writeBtn('Repartir productos', { 'data-correo-doc': String(p.documento_id) }, 'pbtn-sm pbtn-primary') : null,
    p.estado === 'revisar' && p.pdf && p.tipo !== 'gasto' ? writeBtn('Revisar', { 'data-correo-revisar': String(p.id) }, 'pbtn-sm pbtn-primary') : null,
    p.pdf ? h('a', { class: 'pbtn pbtn-sm', href: `${API}/pendientes/${p.id}/archivo`, target: '_blank', rel: 'noopener', text: 'Ver PDF' }) : null,
    p.tipo === 'gasto' ? writeBtn('Ya está', { 'data-correo-hecho': String(p.id), title: 'Lo he registrado a mano en Gastos' }, 'pbtn-sm') : null,
    writeBtn('Descartar', { 'data-correo-descartar': String(p.id), title: 'No hay que registrarlo' }, 'pbtn-sm pbtn-ghost'),
  ];
  return h('li', { class: 'correo-item' }, [
    h('div', {}, [
      h('div', { class: 'correo-archivo' }, [h('strong', { text: p.archivo }), ' ', h('span', { class: 'sbadge sb-pendiente', text: TIPO[p.tipo] ?? p.tipo })]),
      h('div', { class: 'pmuted small', text: [p.de, p.asunto, cuando(p.fecha)].filter(Boolean).join(' · ') }),
      h('div', { class: 'correo-motivo', text: p.motivo }),
    ]),
    h('div', { class: 'pbtn-row' }, acciones),
  ]);
}

/**
 * Pinta el bloque. `onRevisar(analisis)` recibe el PDF ya analizado para
 * revisarlo en la lista de Importar PDF.
 */
export function bloqueCorreo(ctx, { onRevisar }) {
  const caja = h('section', { class: 'psection correo' }, h('p', { class: 'pmuted', text: 'Cargando el correo…' }));

  async function cargar() {
    const [estado, pend] = await Promise.all([api('GET', `${API}/estado`), api('GET', `${API}/pendientes`)]);
    if (!estado.ok) return void caja.replaceChildren(h('p', { class: 'notice', text: estado.error }));
    const lista = pend.ok ? pend.data : [];
    caja.replaceChildren(
      h('div', { class: 'correo-head' }, [
        h('h4', { class: 'psection-title', text: 'Correo' }),
        estado.data.configurado ? writeBtn('Revisar correo ahora', { 'data-correo-ya': '' }, 'pbtn-sm') : null,
      ]),
      lineaEstado(estado.data),
      lista.length
        ? h('details', { class: 'correo-pendientes', open: true }, [
          h('summary', { text: `Para revisar (${lista.length})` }),
          h('ul', { class: 'correo-lista' }, lista.map(fila)),
        ])
        : null,
    );
    return undefined;
  }

  caja.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('[data-correo-ya]')) {
      const b = t.closest('[data-correo-ya]');
      b.setAttribute('aria-busy', 'true');
      b.textContent = 'Revisando…';
      const r = await api('POST', `${API}/revisar`);
      if (!r.ok) showToast(r.error, { tone: 'error' });
      else {
        ctx.markChanged();
        showToast(`Correo revisado: ${r.data.proveedores} facturas o pedidos, ${r.data.gastos} gastos, ${r.data.revisar} para revisar.`);
      }
      return void cargar();
    }
    const doc = t.closest('[data-correo-doc]');
    if (doc) return void ctx.openDoc(Number(doc.dataset.correoDoc), { view: 'importar', params: {} });
    const rev = t.closest('[data-correo-revisar]');
    if (rev) {
      const r = await api('POST', `${API}/pendientes/${rev.dataset.correoRevisar}/analizar`);
      if (!r.ok) return void showToast(r.error, { tone: 'error' });
      onRevisar(r.data);
      return void showToast('Abierto abajo: revisa los datos y pulsa Guardar.');
    }
    for (const [attr, accion, msg] of [['correoHecho', 'hecho', 'Marcado como hecho.'], ['correoDescartar', 'descartar', 'Descartado.']]) {
      const b = t.closest(`[data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`);
      if (!b) continue;
      const r = await api('POST', `${API}/pendientes/${b.dataset[attr]}/${accion}`);
      if (!r.ok) return void showToast(r.error, { tone: 'error' });
      showToast(msg);
      return void cargar();
    }
    return undefined;
  });

  cargar();
  return { caja, recargar: cargar };
}
