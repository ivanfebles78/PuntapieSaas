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

// TPV › Cambios: se escanea lo que el cliente devuelve y, si quiere, lo que
// se lleva a cambio. Si lo nuevo vale más, paga la diferencia; si vale menos
// o no se lleva nada, el resto va a un vale. Cada producto devuelto está en
// buen estado (vuelve al stock) o es defectuoso: va a cuarentena con una
// incidencia de garantía y, por lo que vale, el cliente puede pedir su dinero.

const METODOS_DINERO = Object.freeze([['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['bizum', 'Bizum']]);
const nombreMetodo = (m) => METODOS_DINERO.find(([id]) => id === m)?.[1] ?? m;

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

/** Qué defecto tiene (va a la incidencia de garantía). */
function pedirDefecto(d) {
  const texto = h('textarea', { id: 'def-txt', rows: '3', maxlength: '300', text: d.defecto ?? '' });
  return openDialog({
    eyebrow: 'Producto defectuoso',
    title: d.descripcion,
    lead: 'No vuelve a la venta: queda en cuarentena y se abre una incidencia de garantía para reclamar al proveedor. Las fotos se añaden luego en «Garantías».',
    content: h('div', { class: 'field' }, [h('label', { for: 'def-txt', text: '¿Qué le pasa?' }), texto]),
    submitLabel: 'Marcar como defectuoso',
    onSubmit: async () => {
      const v = texto.value.trim();
      if (v.length < 3) return { error: 'Escribe qué defecto tiene (por ejemplo «se despega la suela»).' };
      return v;
    },
  });
}

export function renderCambio(zona, { user, salir, irGarantias }) {
  let estado = { devueltos: [], nuevos: [], aprobacion: null, reembolso: null };
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
      h('div', { class: 'cb-barra2' }, [modos, h('div', { class: 'cb-extra' }, [
        h('button', { type: 'button', class: 'tpv-ghost', 'data-papel': '', text: 'Compra de antes del TPV' }),
        h('button', { type: 'button', class: 'tpv-ghost', 'data-garantias': '', text: 'Garantías' }),
      ])]),
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
    devueltos: estado.devueltos.map(({ linea_id: l, cantidad, articulo_id: a, descripcion, importe_cent: i, ticket_papel: tp, fecha_ticket: f, estado: e, defecto }) => ({
      ...(l ? { linea_id: l, cantidad } : { articulo_id: a, descripcion, cantidad, importe_cent: i, ticket_papel: tp, fecha_ticket: f }),
      estado: e ?? 'stock', defecto: e === 'defectuoso' ? defecto : null,
    })),
    nuevos: estado.nuevos.map((n) => ({ articulo_id: n.articulo_id, cantidad: n.cantidad })),
    reembolso: estado.reembolso,
  });

  async function recalcular() {
    estado = { ...estado, aprobacion: null };
    calculo = null;
    if (estado.devueltos.length) {
      let r = await api('POST', '/api/tpv/cambios/calcular', cuerpo());
      // Ya no hay nada que devolver en dinero (p. ej. se quitó lo defectuoso): vuelve al vale.
      if (!r.ok && estado.reembolso) {
        estado = { ...estado, reembolso: null };
        r = await api('POST', '/api/tpv/cambios/calcular', cuerpo());
      }
      if (r.ok) calculo = r.data;
      else showToast(r.error, { tone: 'error' });
    }
    if (!calculo?.reembolsable_cent) estado = { ...estado, reembolso: null };
    pintar();
  }

  function pintar() {
    const fila = (texto, sub, importe, attrs, extra = null) => h('li', { class: 'vt-linea' }, [
      h('div', { class: 'vt-l-desc' }, [h('strong', { text: texto }), h('span', { text: sub }), extra]),
      h('strong', { class: 'vt-l-total', text: importe }),
      h('button', { type: 'button', class: 'vt-l-quitar', ...attrs, 'aria-label': `Quitar ${texto}`, text: '✕' }),
    ]);
    // Buen estado (vuelve al stock) o defectuoso (cuarentena y garantía).
    const estadoDom = (d, i) => h('div', { class: 'cb-estado', role: 'group', 'aria-label': `Estado de ${d.descripcion}` }, [
      h('button', { type: 'button', 'data-estado': `${i}:stock`, 'aria-pressed': String(d.estado !== 'defectuoso'), text: 'Buen estado · al stock' }),
      h('button', { type: 'button', 'data-estado': `${i}:defectuoso`, 'aria-pressed': String(d.estado === 'defectuoso'), class: 'is-def', text: 'Defectuoso' }),
    ]);
    lista.replaceChildren(
      h('h3', { class: 'cb-titulo', text: 'Devuelve' }),
      h('ol', { class: 'vt-lineas' }, estado.devueltos.length ? estado.devueltos.map((d, i) => fila(
        d.descripcion,
        [d.talla && d.talla !== 'Única' ? `Talla ${d.talla}` : null, d.linea_id ? `ticket ${d.ticket}` : `ticket de papel ${d.ticket_papel || ''}`.trim(),
          calculo?.devueltos[i]?.fuera_plazo ? 'fuera de plazo' : null, d.estado === 'defectuoso' ? `Defecto: ${d.defecto}` : null].filter(Boolean).join(' · '),
        `−${formatEuros(calculo?.devueltos[i]?.credito ?? d.credito ?? 0)}`, { 'data-quitar-dev': String(i) }, estadoDom(d, i),
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
      c.reembolsable_cent ? h('div', { class: 'cb-dinero', role: 'group', 'aria-label': 'Lo defectuoso: vale o dinero' }, [
        h('span', { text: `Por lo defectuoso puede elegir su dinero (${formatEuros(c.reembolsable_cent)}):` }),
        h('div', { class: 'cb-dinero-op' }, [
          h('button', { type: 'button', 'data-reembolso': '', 'aria-pressed': String(!estado.reembolso), text: 'Vale' }),
          ...METODOS_DINERO.map(([id, nombre]) => h('button', { type: 'button', 'data-reembolso': id, 'aria-pressed': String(estado.reembolso === id), text: nombre })),
        ]),
      ]) : '',
      c.reembolso_cent ? h('div', {}, [h('span', { text: `Se le devuelve (${nombreMetodo(estado.reembolso)})` }), h('strong', { text: formatEuros(c.reembolso_cent) })]) : '',
      h('div', { class: 'vt-total' }, c.a_pagar_cent
        ? [h('span', { text: 'Paga' }), h('strong', { text: formatEuros(c.a_pagar_cent) })]
        : c.reembolso_cent && !c.vale_cent
          ? [h('span', { text: 'Devolver' }), h('strong', { text: formatEuros(c.reembolso_cent) })]
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
    const partes = c ? [
      c.reembolso_cent ? `devolver ${formatEuros(c.reembolso_cent)} (${nombreMetodo(estado.reembolso).toLowerCase()})` : null,
      c.vale_cent ? `dar vale de ${formatEuros(c.vale_cent)}` : null,
    ].filter(Boolean) : [];
    accion.textContent = !c ? 'Hacer el cambio' : c.a_pagar_cent ? `Cobrar diferencia ${formatEuros(c.a_pagar_cent)}`
      : partes.length ? `Hacer la devolución y ${partes.join(' y ')}` : 'Hacer el cambio';
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
      ...p, articulo_id: art?.id ?? null, descripcion: art ? nombreArt(art) : p.descripcion, talla: art?.talla ?? null, cantidad: 1, credito: p.importe_cent, estado: 'stock',
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
    // Dos documentos: la rectificativa (lo devuelto) y, si se lleva algo, su venta.
    const t = r.data;
    imprimirTicket(t.rectificativa, t.venta);
    if (t.vale) imprimirVale({ ...t.vale, tienda: t.tienda });
    estado = { devueltos: [], nuevos: [], aprobacion: null, reembolso: null };
    calculo = null;
    pintar();
    const reembolso = t.rectificativa.reembolso;
    resultados.replaceChildren(h('div', { class: 'vt-hecha' }, [
      h('strong', { text: `Devolución ${t.rectificativa.numero}${t.venta ? ` y venta ${t.venta.numero}` : ''} hechas` }),
      reembolso ? h('p', { class: 'vt-cambio', text: `Devuelve ${formatEuros(reembolso.importe_cent)} en ${nombreMetodo(reembolso.metodo).toLowerCase()}` }) : '',
      t.vale ? h('p', { class: 'vt-cambio', text: `Vale de ${formatEuros(t.vale.importe_cent)} · caduca el ${t.vale.caduca}` }) : '',
      t.incidencias?.length ? h('p', { class: 'cj-ayuda', text: `Lo defectuoso queda en cuarentena: ${t.incidencias.length === 1 ? 'incidencia' : 'incidencias'} de garantía nº ${t.incidencias.join(', ')}. Añade las fotos en «Garantías».` }) : '',
      h('div', { class: 'vt-hecha-acciones' }, [
        t.vale ? h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir-vale': '', text: 'Imprimir el vale otra vez' }) : '',
        h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir': '', text: t.venta ? 'Imprimir los tickets otra vez' : 'Imprimir el ticket otra vez' }),
      ]),
      h('div', { class: 'cb-impresos' }, [
        h('div', { class: 'vt-ticket-vista' }, ticketDom(t.rectificativa)),
        t.venta ? h('div', { class: 'vt-ticket-vista' }, ticketDom(t.venta)) : '',
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
      const yaDevueltas = estado.devueltos.filter((d) => d.linea_id === v.linea_id).reduce((s, d) => s + d.cantidad, 0);
      if (yaDevueltas >= v.quedan) return void showToast('De ese ticket ya no queda nada por devolver.', { tone: 'error' });
      const ya = estado.devueltos.find((d) => d.linea_id === v.linea_id && d.estado !== 'defectuoso');
      if (ya) ya.cantidad += 1;
      else estado.devueltos.push({ linea_id: v.linea_id, descripcion: nombreArt(v.art), talla: v.art.talla, ticket: v.ticket, cantidad: 1, credito: v.precio_unidad_cent, estado: 'stock' });
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
    const est = t.closest('[data-estado]');
    if (est) {
      const [i, valor] = est.dataset.estado.split(':');
      const d = estado.devueltos[Number(i)];
      if (!d || d.estado === valor) return enfocar();
      if (valor === 'defectuoso') {
        const defecto = await pedirDefecto(d);
        if (!defecto) return enfocar();
        Object.assign(d, { estado: 'defectuoso', defecto });
      } else Object.assign(d, { estado: 'stock', defecto: null });
      await recalcular();
      return enfocar();
    }
    const rb = t.closest('[data-reembolso]');
    if (rb) {
      estado = { ...estado, reembolso: rb.dataset.reembolso || null };
      await recalcular();
      return enfocar();
    }
    if (t.closest('[data-garantias]')) {
      if ((estado.devueltos.length || estado.nuevos.length) && !window.confirm('Hay un cambio sin terminar. ¿Salir y perderlo?')) return enfocar();
      return void irGarantias?.();
    }
    const qd = t.closest('[data-quitar-dev]');
    if (qd) { estado.devueltos.splice(Number(qd.dataset.quitarDev), 1); return void recalcular(); }
    const qn = t.closest('[data-quitar-nuevo]');
    if (qn) { estado.nuevos.splice(Number(qn.dataset.quitarNuevo), 1); return void recalcular(); }
    if (t.closest('[data-aprobar]')) {
      const id = await pedirAprobacion({
        titulo: 'Aprobar el cambio', ruta: '/api/tpv/cambios', cuerpo: { devueltos: cuerpo().devueltos, reembolso: estado.reembolso },
        resumen: `Cambio por ${formatEuros(calculo.credito_cent)} (${calculo.motivos.join(' y ')}).`,
      });
      if (id) { estado = { ...estado, aprobacion: id }; pintar(); }
      return enfocar();
    }
    if (t.closest('[data-hacer]')) return void hacer();
    if (t.closest('[data-vaciar]') && (estado.devueltos.length || estado.nuevos.length) && window.confirm('¿Vaciar el cambio?')) {
      estado = { devueltos: [], nuevos: [], aprobacion: null, reembolso: null };
      calculo = null;
      pintar();
      return enfocar();
    }
    if (t.closest('[data-reimprimir]')) {
      const u = JSON.parse(resultados.dataset.ultimo);
      return void imprimirTicket(u.rectificativa, u.venta);
    }
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
