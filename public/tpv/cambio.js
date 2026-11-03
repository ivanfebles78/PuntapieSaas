import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { eurToCent } from '../proveedores/util.js';
import { showToast } from '../toast.js';
import { modelosDom, tallaPulsada } from './articulos.js';
import { cobrar } from './cobro.js';
import { pedirAprobacion } from './dialogos.js';
import { imprimirTicket, ticketDom } from './ticket.js';
import { imprimirVale, valeImpresoDom } from './vale.js';

// TPV › Cambios: se escanea lo que el cliente devuelve (vuelve al stock) y,
// si quiere, lo que se lleva a cambio. Si lo nuevo vale más, paga la
// diferencia; si vale menos o no se lleva nada, el resto va a un vale.
// No se devuelve dinero.

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' }).format(new Date());
const nombreArt = (a) => [a.marca, a.modelo !== a.referencia ? a.modelo : null, a.referencia, a.color].filter(Boolean).join(' · ');

/** Compra de antes del TPV: importe por unidad que pone el ticket de papel (lo aprueba un Administrador). */
function pedirTicketPapel(art) {
  const importe = h('input', { id: 'pap-imp', inputmode: 'decimal', autocomplete: 'off', value: art?.pvp_cent ? (art.pvp_cent / 100).toFixed(2).replace('.', ',') : '' });
  const numero = h('input', { id: 'pap-num', maxlength: '40', autocomplete: 'off' });
  const fecha = h('input', { id: 'pap-fecha', type: 'date', max: hoy() });
  const desc = h('input', { id: 'pap-desc', maxlength: '80', autocomplete: 'off' });
  const campo = (id, label, control) => h('div', { class: 'field' }, [h('label', { for: id, text: label }), control]);
  return openDialog({
    eyebrow: 'Ticket de papel',
    title: art ? nombreArt(art) : 'Compra de antes del TPV',
    lead: 'Escribe el importe que pagó, tal como sale en su ticket. Este cambio necesita la aprobación de un Administrador.',
    content: h('div', { class: 'tpvd-grid' }, [
      art ? '' : campo('pap-desc', 'Producto que devuelve', desc),
      campo('pap-imp', 'Importe pagado por unidad (€)', importe), campo('pap-num', 'Nº del ticket', numero), campo('pap-fecha', 'Fecha del ticket', fecha),
    ]),
    submitLabel: 'Añadir a lo devuelto',
    onSubmit: async () => {
      const c = eurToCent(importe.value);
      if (!art && !desc.value.trim()) return { error: 'Escribe qué producto devuelve.' };
      if (!c || c <= 0) return { error: 'Escribe el importe del ticket, por ejemplo 59,95.' };
      if (!fecha.value) return { error: 'Escribe la fecha del ticket (para el plazo de 30 días).' };
      return { importe_cent: c, ticket_papel: numero.value.trim(), fecha_ticket: fecha.value, descripcion: desc.value.trim() };
    },
  });
}

export function renderCambio(zona, { user, salir }) {
  let estado = { devueltos: [], nuevos: [], aprobacion: null };
  let modo = 'devuelve'; // lo que se escanea: lo que devuelve o lo que se lleva
  let calculo = null;

  const buscador = h('input', { class: 'vt-buscar', type: 'search', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Escanear o buscar' });
  const modos = h('div', { class: 'cb-modos', role: 'group', 'aria-label': 'Qué se escanea' }, [
    h('button', { type: 'button', 'data-modo': 'devuelve', text: '1 · Lo que devuelve' }),
    h('button', { type: 'button', 'data-modo': 'nuevo', text: '2 · Lo que se lleva' }),
  ]);
  const resultados = h('div', { class: 'vt-resultados', 'aria-live': 'polite' });
  const lista = h('div', { class: 'cb-lista' });
  const totales = h('div', { class: 'vt-totales' });
  const aviso = h('div', { class: 'vt-aviso', hidden: true });
  const accion = h('button', { class: 'vt-cobrar', type: 'button', 'data-hacer': '', disabled: true, text: 'Hacer el cambio' });

  const raiz = h('div', { class: 'vt' }, [
    h('section', { class: 'vt-izq' }, [
      h('div', { class: 'vt-barra' }, [h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }), buscador]),
      h('div', { class: 'cb-barra2' }, [modos, h('button', { type: 'button', class: 'tpv-ghost', 'data-papel': '', text: 'Compra de antes del TPV' })]),
      resultados,
    ]),
    h('section', { class: 'vt-ticket', 'aria-label': 'Cambio en curso' }, [
      h('div', { class: 'vt-ticket-cab' }, [h('h2', { text: 'Cambio' }), h('span', { class: 'vt-vendedor', text: user.name }), h('button', { class: 'vt-vaciar', type: 'button', 'data-vaciar': '', text: 'Vaciar' })]),
      lista, totales, aviso, accion,
    ]),
  ]);

  const enfocar = () => setTimeout(() => buscador.focus(), 0);
  const ayuda = (t) => h('div', { class: 'vt-ayuda' }, [h('strong', { text: t }), h('span', { text: 'Código de barras, referencia, marca o modelo.' })]);

  function pintarModo() {
    modos.querySelectorAll('[data-modo]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
    buscador.placeholder = modo === 'devuelve' ? 'Escanea el producto que devuelve…' : 'Escanea lo que se lleva…';
    resultados.replaceChildren(ayuda(modo === 'devuelve' ? 'Escanea el producto que el cliente devuelve' : 'Escanea lo que se lleva a cambio'));
  }

  const cuerpo = () => ({
    devueltos: estado.devueltos.map(({ linea_id: l, cantidad, articulo_id: a, descripcion, importe_cent: i, ticket_papel: tp, fecha_ticket: f }) => (l
      ? { linea_id: l, cantidad } : { articulo_id: a, descripcion, cantidad, importe_cent: i, ticket_papel: tp, fecha_ticket: f })),
    nuevos: estado.nuevos.map((n) => ({ articulo_id: n.articulo_id, cantidad: n.cantidad })),
  });

  async function recalcular() {
    estado = { ...estado, aprobacion: null };
    calculo = null;
    if (estado.devueltos.length) {
      const r = await api('POST', '/api/tpv/cambios/calcular', cuerpo());
      if (r.ok) calculo = r.data;
      else showToast(r.error, { tone: 'error' });
    }
    pintar();
  }

  function pintar() {
    const fila = (texto, sub, importe, attrs) => h('li', { class: 'vt-linea' }, [
      h('div', { class: 'vt-l-desc' }, [h('strong', { text: texto }), h('span', { text: sub })]),
      h('strong', { class: 'vt-l-total', text: importe }),
      h('button', { type: 'button', class: 'vt-l-quitar', ...attrs, 'aria-label': `Quitar ${texto}`, text: '✕' }),
    ]);
    lista.replaceChildren(
      h('h3', { class: 'cb-titulo', text: 'Devuelve' }),
      h('ol', { class: 'vt-lineas' }, estado.devueltos.length ? estado.devueltos.map((d, i) => fila(
        d.descripcion,
        [d.talla && d.talla !== 'Única' ? `Talla ${d.talla}` : null, d.linea_id ? `ticket ${d.ticket}` : `ticket de papel ${d.ticket_papel || ''}`.trim(), d.fuera_plazo ? 'fuera de plazo' : null].filter(Boolean).join(' · '),
        `−${formatEuros(calculo?.devueltos[i]?.credito ?? d.credito ?? 0)}`, { 'data-quitar-dev': String(i) },
      )) : [h('li', { class: 'vt-vacio', text: 'Escanea lo que devuelve.' })]),
      h('h3', { class: 'cb-titulo', text: 'Se lleva' }),
      h('ol', { class: 'vt-lineas' }, estado.nuevos.length ? estado.nuevos.map((n, i) => fila(
        n.descripcion, `Talla ${n.talla} · ${n.cantidad} ud.`, formatEuros(n.precio_cent * n.cantidad), { 'data-quitar-nuevo': String(i) },
      )) : [h('li', { class: 'vt-vacio', text: 'Nada (o un vale por el importe).' })]),
    );
    const c = calculo;
    totales.replaceChildren(...(c ? [
      h('div', {}, [h('span', { text: 'Lo devuelto' }), h('span', { text: formatEuros(c.credito_cent) })]),
      h('div', {}, [h('span', { text: 'Lo nuevo' }), h('span', { text: formatEuros(c.nuevos_cent) })]),
      h('div', { class: 'vt-total' }, c.a_pagar_cent
        ? [h('span', { text: 'Paga' }), h('strong', { text: formatEuros(c.a_pagar_cent) })]
        : [h('span', { text: 'Vale por' }), h('strong', { text: formatEuros(c.vale_cent) })]),
    ] : []));
    const necesita = c?.requiere_aprobacion && user.role !== 'admin';
    aviso.hidden = !necesita;
    aviso.classList.toggle('is-ok', Boolean(estado.aprobacion));
    aviso.replaceChildren(...(necesita ? [
      h('span', { text: estado.aprobacion ? '✓ Cambio aprobado por un Administrador.' : `Necesita aprobación (${c.motivos.join(' y ')}).` }),
      estado.aprobacion ? '' : h('button', { type: 'button', 'data-aprobar': '', text: 'Pedir aprobación' }),
    ] : []));
    accion.disabled = !c || (necesita && !estado.aprobacion);
    accion.textContent = !c ? 'Hacer el cambio' : c.a_pagar_cent ? `Cobrar diferencia ${formatEuros(c.a_pagar_cent)}` : c.vale_cent ? `Hacer el cambio y dar vale de ${formatEuros(c.vale_cent)}` : 'Hacer el cambio';
  }

  /** Producto devuelto: sus ventas del TPV para elegir de cuál sale (o el ticket de papel). */
  async function verVentas(art) {
    const r = await api('GET', `/api/tpv/cambios/ventas/${art.id}`);
    if (!r.ok) return void showToast(r.error, { tone: 'error' });
    const ventas = r.data.filter((v) => v.quedan > 0);
    resultados.replaceChildren(h('article', { class: 'vt-modelo' }, [
      h('div', { class: 'vt-m-cab' }, [h('strong', { text: nombreArt(art) }), h('span', { text: `Talla ${art.talla}` })]),
      ventas.length
        ? h('ul', { class: 'cb-ventas' }, ventas.map((v) => h('li', {}, [
          h('span', { text: `Ticket ${v.ticket} · ${v.fecha} (hace ${v.dias} ${v.dias === 1 ? 'día' : 'días'})` }),
          h('strong', { text: formatEuros(v.precio_unidad_cent) }),
          v.dentro_plazo ? '' : h('span', { class: 'cb-plazo', text: 'fuera de plazo' }),
          h('button', { type: 'button', class: 'vt-libre', 'data-venta': JSON.stringify({ ...v, art }), text: 'Devolver' }),
        ])))
        : h('p', { class: 'cj-ayuda', text: 'No consta vendido con el TPV: si trae el ticket de papel, usa «Ticket de papel».' }),
      h('button', { type: 'button', class: 'tpv-ghost', 'data-papel-art': JSON.stringify(art), text: 'Ticket de papel (compra de antes del TPV)' }),
    ]));
  }

  async function anadirPapel(art) {
    const p = await pedirTicketPapel(art);
    if (!p) return enfocar();
    estado.devueltos.push({
      ...p, articulo_id: art?.id ?? null, descripcion: art ? nombreArt(art) : p.descripcion, talla: art?.talla ?? null, cantidad: 1, credito: p.importe_cent,
    });
    await recalcular();
    return enfocar();
  }

  async function elegido(art) {
    if (modo === 'devuelve') return verVentas(art);
    if (art.pvp_cent == null) return void showToast('Ese artículo no tiene PVP: ponlo en Inventario.', { tone: 'error' });
    const ya = estado.nuevos.find((n) => n.articulo_id === art.id);
    if (ya) ya.cantidad += 1;
    else estado.nuevos.push({ articulo_id: art.id, descripcion: nombreArt(art), talla: art.talla, precio_cent: art.pvp_cent, cantidad: 1 });
    await recalcular();
    return enfocar();
  }

  async function buscar(q) {
    if (!q.trim()) return;
    const r = await api('GET', `/api/tpv/buscar?q=${encodeURIComponent(q.trim())}`);
    if (!r.ok) return void showToast(r.error, { tone: 'error' });
    buscador.value = '';
    if (r.data.exacto) return void elegido(r.data.exacto);
    if (!r.data.modelos?.length) return void resultados.replaceChildren(ayuda(`No hay nada con «${q.trim()}»`));
    resultados.replaceChildren(...modelosDom(r.data.modelos));
    resultados.dataset.modelos = JSON.stringify(r.data.modelos);
  }

  async function hacer() {
    const c = calculo;
    let pagos = [];
    if (c.a_pagar_cent) {
      pagos = await cobrar(c.a_pagar_cent);
      if (!pagos) return enfocar();
    }
    const r = await api('POST', '/api/tpv/cambios', { ...cuerpo(), pagos, aprobacion_id: estado.aprobacion });
    if (!r.ok) {
      showToast(r.error, { tone: 'error' });
      return enfocar();
    }
    const t = r.data;
    imprimirTicket(t);
    if (t.vale) imprimirVale({ ...t.vale, tienda: t.tienda });
    estado = { devueltos: [], nuevos: [], aprobacion: null };
    calculo = null;
    pintar();
    resultados.replaceChildren(h('div', { class: 'vt-hecha' }, [
      h('strong', { text: `Cambio ${t.numero} hecho` }),
      t.vale ? h('p', { class: 'vt-cambio', text: `Vale de ${formatEuros(t.vale.importe_cent)} · caduca el ${t.vale.caduca}` }) : '',
      h('div', { class: 'vt-hecha-acciones' }, [
        t.vale ? h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir-vale': '', text: 'Imprimir el vale otra vez' }) : '',
        h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir': '', text: 'Imprimir el ticket otra vez' }),
      ]),
      h('div', { class: 'cb-impresos' }, [
        h('div', { class: 'vt-ticket-vista' }, ticketDom(t)),
        t.vale ? h('div', { class: 'vt-ticket-vista' }, valeImpresoDom({ ...t.vale, tienda: t.tienda })) : '',
      ]),
    ]));
    resultados.dataset.ultimo = JSON.stringify(t);
    return enfocar();
  }

  buscador.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    buscar(buscador.value);
  });

  raiz.addEventListener('click', async (e) => {
    const t = e.target;
    const m = t.closest('[data-modo]');
    if (m) {
      modo = m.dataset.modo;
      pintarModo();
      return enfocar();
    }
    const talla = t.closest('[data-g]');
    if (talla) {
      const art = tallaPulsada(resultados, talla);
      if (art) await elegido(art);
      return undefined;
    }
    const venta = t.closest('[data-venta]');
    if (venta) {
      const v = JSON.parse(venta.dataset.venta);
      const ya = estado.devueltos.find((d) => d.linea_id === v.linea_id);
      if ((ya?.cantidad ?? 0) >= v.quedan) return void showToast('De ese ticket ya no queda nada por devolver.', { tone: 'error' });
      if (ya) ya.cantidad += 1;
      else estado.devueltos.push({ linea_id: v.linea_id, descripcion: nombreArt(v.art), talla: v.art.talla, ticket: v.ticket, cantidad: 1, fuera_plazo: !v.dentro_plazo, credito: v.precio_unidad_cent });
      await recalcular();
      resultados.replaceChildren(h('div', { class: 'vt-ayuda' }, [
        h('strong', { text: 'Añadido a lo devuelto.' }),
        h('span', { text: '¿Se lleva algo a cambio? Pulsa «2 · Lo que se lleva» y escanéalo. Si no, el importe irá a un vale.' }),
      ]));
      return enfocar();
    }
    const papel = t.closest('[data-papel-art]');
    if (papel) return void anadirPapel(JSON.parse(papel.dataset.papelArt));
    if (t.closest('[data-papel]')) return void anadirPapel(null);
    const qd = t.closest('[data-quitar-dev]');
    if (qd) { estado.devueltos.splice(Number(qd.dataset.quitarDev), 1); return void recalcular(); }
    const qn = t.closest('[data-quitar-nuevo]');
    if (qn) { estado.nuevos.splice(Number(qn.dataset.quitarNuevo), 1); return void recalcular(); }
    if (t.closest('[data-aprobar]')) {
      const id = await pedirAprobacion({
        titulo: 'Aprobar el cambio', ruta: '/api/tpv/cambios', cuerpo: { devueltos: cuerpo().devueltos },
        resumen: `Cambio por ${formatEuros(calculo.credito_cent)} (${calculo.motivos.join(' y ')}).`,
      });
      if (id) { estado = { ...estado, aprobacion: id }; pintar(); }
      return enfocar();
    }
    if (t.closest('[data-hacer]')) return void hacer();
    if (t.closest('[data-vaciar]') && (estado.devueltos.length || estado.nuevos.length) && window.confirm('¿Vaciar el cambio?')) {
      estado = { devueltos: [], nuevos: [], aprobacion: null };
      calculo = null;
      pintar();
      return enfocar();
    }
    if (t.closest('[data-reimprimir]')) return void imprimirTicket(JSON.parse(resultados.dataset.ultimo));
    if (t.closest('[data-reimprimir-vale]')) {
      const u = JSON.parse(resultados.dataset.ultimo);
      return void imprimirVale({ ...u.vale, tienda: u.tienda });
    }
    if (t.closest('[data-salir]')) {
      if ((estado.devueltos.length || estado.nuevos.length) && !window.confirm('Hay un cambio sin terminar. ¿Salir y perderlo?')) return enfocar();
      return void salir();
    }
    return undefined;
  });

  pintarModo();
  pintar();
  zona.replaceChildren(raiz);
  enfocar();
  return raiz;
}
