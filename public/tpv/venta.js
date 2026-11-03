import { api } from '../api.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { showToast } from '../toast.js';
import { calcularVenta } from './calculo.js';
import { cobrar } from './cobro.js';
import { pedirAprobacion, pedirDescuento, pedirLibre, pedirPrecio } from './dialogos.js';
import { imprimirTicket, ticketDom } from './ticket.js';

// TPV › Venta: una sola casilla para todo (la pistola, el código a mano, el
// código de la caja, la referencia o un texto), rejilla de tallas, artículo
// libre, cantidades y descuentos. La casilla recupera el foco tras cada paso
// para que la pistola siempre escriba en ella.

const BUSCAR_TRAS_MS = 300;

function estadoInicial() {
  return { lineas: [], descuento: null, aprobacion: null };
}

const clave = (l) => (l.articulo_id ? `a${l.articulo_id}` : null);

/** Pinta la pantalla de venta dentro de `zona`. `salir()` vuelve al inicio del TPV. */
export function renderVenta(zona, { user, salir }) {
  let venta = estadoInicial();
  let temporizador = null;

  const buscador = h('input', {
    class: 'vt-buscar', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Escanea o escribe código, referencia o modelo…', 'aria-label': 'Buscar o escanear',
  });
  const resultados = h('div', { class: 'vt-resultados', 'aria-live': 'polite' }, ayuda());
  const lineasEl = h('ol', { class: 'vt-lineas' });
  const totalesEl = h('div', { class: 'vt-totales' });
  const aviso = h('div', { class: 'vt-aviso', hidden: true });
  const cobrarBtn = h('button', { class: 'vt-cobrar', type: 'button', 'data-cobrar': '', disabled: true, text: 'Cobrar' });

  const raiz = h('div', { class: 'vt' }, [
    h('section', { class: 'vt-izq' }, [
      h('div', { class: 'vt-barra' }, [
        h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }),
        buscador,
        h('button', { class: 'vt-libre', type: 'button', 'data-libre': '', text: '+ Artículo libre' }),
      ]),
      resultados,
    ]),
    h('section', { class: 'vt-ticket', 'aria-label': 'Ticket en curso' }, [
      h('div', { class: 'vt-ticket-cab' }, [h('h2', { text: 'Venta' }), h('span', { class: 'vt-vendedor', text: user.name }), h('button', { class: 'vt-vaciar', type: 'button', 'data-vaciar': '', text: 'Vaciar' })]),
      lineasEl,
      totalesEl,
      aviso,
      cobrarBtn,
    ]),
  ]);

  function ayuda(texto = null) {
    return h('div', { class: 'vt-ayuda' }, [
      h('strong', { text: texto ?? 'Escanea un producto o escribe para buscarlo' }),
      h('span', { text: 'Código de barras, código de la caja, referencia, marca, modelo o color («gioseppo marino»).' }),
    ]);
  }

  const enfocar = () => setTimeout(() => buscador.focus(), 0);

  // La venta tal como la recibe el servidor.
  const ventaApi = () => ({
    lineas: venta.lineas.map((l) => ({ articulo_id: l.articulo_id, descripcion: l.descripcion, precio_cent: l.precio_cent, cantidad: l.cantidad, tipo: l.tipo, descuento: l.descuento })),
    descuento: venta.descuento,
  });

  function calcular() {
    if (!venta.lineas.length) return null;
    try {
      return calcularVenta(venta.lineas, venta.descuento);
    } catch {
      return null;
    }
  }

  // Cualquier cambio en la venta invalida una aprobación ya concedida.
  function cambiar(mutar) {
    mutar();
    venta = { ...venta, aprobacion: null };
    pintar();
  }

  function pintar() {
    const c = calcular();
    lineasEl.replaceChildren(...(venta.lineas.length ? venta.lineas.map((l, i) => {
      const r = c?.lineas[i];
      return h('li', { class: 'vt-linea' }, [
        h('div', { class: 'vt-l-desc' }, [
          h('strong', { text: l.descripcion }),
          h('span', { text: [l.talla && l.talla !== 'Única' ? `Talla ${l.talla}` : null, `${formatEuros(l.precio_cent)}/ud.`, l.stock != null && l.stock < l.cantidad ? '¡sin stock!' : null].filter(Boolean).join(' · ') }),
        ]),
        h('div', { class: 'vt-l-cant' }, [
          h('button', { type: 'button', 'data-menos': String(i), 'aria-label': 'Una menos', text: '−' }),
          h('span', { text: String(l.cantidad) }),
          h('button', { type: 'button', 'data-mas': String(i), 'aria-label': 'Una más', text: '+' }),
        ]),
        h('button', { type: 'button', class: `vt-l-dto${l.descuento ? ' is-on' : ''}`, 'data-dto': String(i), title: 'Descuento en esta línea', text: l.descuento ? (l.descuento.tipo === 'pct' ? `−${String(l.descuento.valor).replace('.', ',')} %` : `−${formatEuros(l.descuento.valor)}`) : '%' }),
        h('strong', { class: 'vt-l-total', text: formatEuros(r?.total_cent ?? l.precio_cent * l.cantidad) }),
        h('button', { type: 'button', class: 'vt-l-quitar', 'data-quitar': String(i), 'aria-label': `Quitar ${l.descripcion}`, text: '✕' }),
      ]);
    }) : [h('li', { class: 'vt-vacio', text: 'Aún no hay productos.' })]));

    totalesEl.replaceChildren(...(c ? [
      h('div', {}, [h('span', { text: 'Subtotal' }), h('span', { text: formatEuros(c.subtotal_cent) })]),
      h('div', {}, [
        h('button', { type: 'button', class: `vt-dto-total${venta.descuento ? ' is-on' : ''}`, 'data-dto-total': '', text: venta.descuento ? 'Descuento al total ✎' : '+ Descuento al total' }),
        h('span', { text: c.descuento_cent ? `−${formatEuros(c.descuento_cent)} (${String(c.pct_descuento).replace('.', ',')} %)` : '—' }),
      ]),
      h('div', { class: 'vt-total' }, [h('span', { text: 'Total' }), h('strong', { text: formatEuros(c.total_cent) })]),
    ] : []));

    const necesita = c?.requiere_aprobacion && user.role !== 'admin';
    aviso.hidden = !necesita;
    aviso.replaceChildren(...(necesita ? [
      h('span', { text: venta.aprobacion ? '✓ Descuento aprobado por un Administrador.' : `El descuento (${String(c.pct_descuento).replace('.', ',')} %) pasa del 15 %: necesita aprobación.` }),
      venta.aprobacion ? '' : h('button', { type: 'button', 'data-aprobar': '', text: 'Pedir aprobación' }),
    ] : []));
    aviso.classList.toggle('is-ok', Boolean(venta.aprobacion));
    cobrarBtn.disabled = !c || (necesita && !venta.aprobacion);
    cobrarBtn.textContent = c ? `Cobrar ${formatEuros(c.total_cent)}` : 'Cobrar';
  }

  async function anadir(art) {
    let precio = art.pvp_cent;
    if (precio == null) {
      precio = await pedirPrecio(`${art.marca} ${art.referencia}${art.talla && art.talla !== 'Única' ? ` · T. ${art.talla}` : ''}`);
      if (!precio) return enfocar();
    }
    cambiar(() => {
      const ya = venta.lineas.find((l) => clave(l) === `a${art.id}`);
      if (ya) ya.cantidad += 1;
      else {
        venta.lineas.push({
          articulo_id: art.id, descripcion: [art.marca, art.modelo !== art.referencia ? art.modelo : null, art.referencia, art.color].filter(Boolean).join(' · '),
          talla: art.talla, tipo: art.tipo, precio_cent: precio, cantidad: 1, descuento: null, stock: art.stock,
        });
      }
    });
    if (art.stock != null && art.stock < 1) showToast('El stock dice que no queda: se vende igualmente y se avisa en el ticket.', { tone: 'error' });
    return enfocar();
  }

  function pintarModelos(modelos, consulta) {
    if (!modelos.length) {
      resultados.replaceChildren(ayuda(`No hay nada con «${consulta}»`), h('button', { type: 'button', class: 'vt-libre', 'data-libre': '', text: '+ Añadirlo como artículo libre' }));
      return;
    }
    resultados.replaceChildren(...modelos.map((m, gi) => h('article', { class: 'vt-modelo' }, [
      h('div', { class: 'vt-m-cab' }, [
        h('strong', { text: `${m.marca} · ${m.modelo}` }),
        h('span', { text: [m.referencia, m.color, m.detalle].filter(Boolean).join(' · ') }),
      ]),
      h('div', { class: 'vt-tallas' }, m.tallas.map((t, ti) => h('button', {
        type: 'button', class: `vt-talla${t.stock > 0 ? '' : ' is-agotada'}`, 'data-g': String(gi), 'data-t': String(ti),
        title: t.stock > 0 ? `${t.stock} en tienda` : 'Sin stock',
      }, [h('strong', { text: t.talla === 'Única' ? 'Única' : t.talla }), h('span', { text: t.pvp_cent != null ? formatEuros(t.pvp_cent) : 'sin PVP' }), h('small', { text: t.stock > 0 ? `${t.stock} ${t.stock === 1 ? 'ud.' : 'uds.'}` : 'agotada' })]))),
    ])));
    resultados.dataset.modelos = JSON.stringify(modelos);
  }

  async function buscar(consulta, { escaneado = false } = {}) {
    const q = consulta.trim();
    if (!q) return void resultados.replaceChildren(ayuda());
    const res = await api('GET', `/api/tpv/buscar?q=${encodeURIComponent(q)}`);
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    if (res.data.exacto) {
      buscador.value = '';
      resultados.replaceChildren(ayuda(`Añadido: ${res.data.exacto.marca} ${res.data.exacto.referencia} · T. ${res.data.exacto.talla}`));
      return void anadir(res.data.exacto);
    }
    // Un código escaneado que no existe: se avisa claro (la pistola escribe solo cifras).
    if (escaneado && /^\d{8,14}$/.test(q) && !res.data.modelos.length) showToast(`El código ${q} no está en el stock.`, { tone: 'error' });
    return void pintarModelos(res.data.modelos, q);
  }

  async function libre(concepto = '') {
    const l = await pedirLibre({ concepto });
    if (l) cambiar(() => venta.lineas.push({ articulo_id: null, ...l, talla: null, descuento: null, stock: null }));
    enfocar();
  }

  async function pedirDto(i) {
    const l = venta.lineas[i];
    const d = await pedirDescuento({ titulo: l.descripcion, actual: l.descuento, importe: l.precio_cent * l.cantidad });
    if (d !== undefined) cambiar(() => { l.descuento = d; });
    enfocar();
  }

  async function pedirDtoTotal() {
    const c = calcular();
    const d = await pedirDescuento({ titulo: 'Descuento al total', actual: venta.descuento, importe: c.subtotal_cent });
    if (d !== undefined) cambiar(() => { venta.descuento = d; });
    enfocar();
  }

  async function aprobar() {
    const id = await pedirAprobacion({ venta: ventaApi(), calculo: calcular() });
    if (id) {
      venta = { ...venta, aprobacion: id };
      pintar();
      showToast('Descuento aprobado.');
    }
    enfocar();
  }

  async function cobro() {
    const c = calcular();
    const pagos = await cobrar(c.total_cent);
    if (!pagos) return enfocar();
    const res = await api('POST', '/api/tpv/ventas', { ...ventaApi(), pagos, aprobacion_id: venta.aprobacion });
    if (!res.ok) {
      showToast(res.error, { tone: 'error' });
      return enfocar();
    }
    const t = res.data;
    imprimirTicket(t);
    buscador.value = '';
    venta = estadoInicial();
    pintar();
    resultados.replaceChildren(h('div', { class: 'vt-hecha' }, [
      h('strong', { text: `Venta ${t.numero} cobrada` }),
      t.cambio_cent ? h('p', { class: 'vt-cambio', text: `Cambio: ${formatEuros(t.cambio_cent)}` }) : null,
      t.sin_stock?.length ? h('p', { class: 'vt-sinstock', text: `Sin stock en el sistema: ${t.sin_stock.join(', ')}. Revísalo en Inventario.` }) : null,
      h('div', { class: 'vt-hecha-acciones' }, [
        h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir': '', text: 'Imprimir otra copia' }),
      ]),
      h('div', { class: 'vt-ticket-vista' }, ticketDom(t)),
    ]));
    resultados.dataset.ultimo = JSON.stringify(t);
    return enfocar();
  }

  // La pistola escribe el código y pulsa Intro; al teclear, se busca al parar.
  buscador.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(temporizador);
    buscar(buscador.value, { escaneado: true });
  });
  buscador.addEventListener('input', () => {
    clearTimeout(temporizador);
    const q = buscador.value.trim();
    if (q.length < 3 || /^\d+$/.test(q)) return; // las cifras esperan al Intro (puede ser la pistola)
    temporizador = setTimeout(() => buscar(q), BUSCAR_TRAS_MS);
  });

  raiz.addEventListener('click', async (e) => {
    const t = e.target;
    const talla = t.closest('[data-g]');
    if (talla) {
      const modelos = JSON.parse(resultados.dataset.modelos ?? '[]');
      const art = modelos[Number(talla.dataset.g)]?.tallas[Number(talla.dataset.t)];
      if (art) await anadir(art);
      return;
    }
    const n = (attr) => Number(t.closest(`[data-${attr}]`)?.dataset[attr]);
    if (t.closest('[data-mas]')) cambiar(() => { venta.lineas[n('mas')].cantidad += 1; });
    else if (t.closest('[data-menos]')) {
      cambiar(() => {
        const l = venta.lineas[n('menos')];
        if (l.cantidad > 1) l.cantidad -= 1;
        else venta.lineas.splice(n('menos'), 1);
      });
    } else if (t.closest('[data-quitar]')) cambiar(() => venta.lineas.splice(n('quitar'), 1));
    else if (t.closest('[data-dto]')) return void pedirDto(n('dto'));
    else if (t.closest('[data-dto-total]')) return void pedirDtoTotal();
    else if (t.closest('[data-aprobar]')) return void aprobar();
    else if (t.closest('[data-cobrar]')) return void cobro();
    else if (t.closest('[data-libre]')) return void libre(/^\d+$/.test(buscador.value.trim()) ? '' : buscador.value.trim());
    else if (t.closest('[data-vaciar]')) {
      if (venta.lineas.length && window.confirm('¿Vaciar la venta?')) { venta = estadoInicial(); pintar(); }
    } else if (t.closest('[data-reimprimir]')) imprimirTicket(JSON.parse(resultados.dataset.ultimo));
    else if (t.closest('[data-salir]')) {
      if (venta.lineas.length && !window.confirm('Hay una venta sin cobrar. ¿Salir y perderla?')) return enfocar();
      return void salir();
    } else return undefined;
    return enfocar();
  });

  pintar();
  zona.replaceChildren(raiz);
  enfocar();
  return raiz;
}
