import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { eurToCent } from '../proveedores/util.js';
import { showToast } from '../toast.js';
import { pedirAprobacion } from './dialogos.js';
import { recuentoDinero } from './recuento.js';
import { imprimir } from './ticket.js';

// TPV › Caja: apertura con el recuento del dinero, entradas y salidas de
// efectivo, y cierre con arqueo (lo contado debe ser inicial + efectivo de
// ventas + entradas − salidas). Si no cuadra, el cierre lo aprueba un Administrador.

const METODO = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos', vales: 'Vales' });
const linea = (izq, der, cls = '') => h('div', { class: `cj-linea ${cls}` }, [h('span', { text: izq }), h('strong', { text: der })]);
const firmado = (c) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${formatEuros(Math.abs(c))}`;

/** Apertura: recuento (relleno con lo que se contó al cerrar la última vez). */
function pantallaAbrir(zona, datos, { alAbrir, salir }) {
  const rc = recuentoDinero(datos.denominaciones, datos.recuento_sugerido);
  const bloqueada = datos.caja_diaria_hoy;
  zona.replaceChildren(h('section', { class: 'cj' }, [
    h('div', { class: 'cj-cab' }, [
      h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }),
      h('h1', { class: 'cj-titulo', tabindex: '-1', text: 'Abrir caja' }),
    ]),
    h('p', { class: 'cj-ayuda', text: 'Cuenta el dinero con el que empieza la caja. Viene relleno con lo que se contó en el último cierre: corrígelo si no coincide.' }),
    bloqueada ? h('p', { class: 'cj-error', text: 'Hoy ya se apuntaron ventas en la Caja diaria: el TPV y la Caja diaria no se usan el mismo día.' }) : '',
    rc.el,
    h('button', { class: 'vt-cobrar cj-accion', type: 'button', 'data-abrir': '', disabled: bloqueada, text: 'Abrir caja' }),
  ]));
  zona.querySelector('[data-salir]').addEventListener('click', salir);
  zona.querySelector('[data-abrir]').addEventListener('click', async () => {
    const res = await api('POST', '/api/tpv/caja/abrir', { recuento: rc.leer() });
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    showToast(`Caja abierta con ${formatEuros(res.data.inicial_cent)}.`);
    return void alAbrir(res.data);
  });
  zona.querySelector('h1').focus();
}

async function pedirMovimiento(tipo) {
  const importe = h('input', { id: 'mov-imp', inputmode: 'decimal', autocomplete: 'off' });
  const concepto = h('input', { id: 'mov-con', maxlength: '120', autocomplete: 'off' });
  return openDialog({
    eyebrow: 'Caja',
    title: tipo === 'entrada' ? 'Entrada de dinero' : 'Salida de dinero',
    lead: tipo === 'entrada' ? 'Dinero que se mete en la caja sin ser una venta (por ejemplo, cambio del banco).' : 'Dinero que se saca de la caja (por ejemplo, pagar al cartero o una compra pequeña).',
    content: h('div', { class: 'tpvd-grid' }, [
      h('div', { class: 'field' }, [h('label', { for: 'mov-imp', text: 'Importe (€)' }), importe]),
      h('div', { class: 'field' }, [h('label', { for: 'mov-con', text: 'Concepto' }), concepto]),
    ]),
    submitLabel: 'Apuntar',
    onSubmit: async () => {
      const cents = eurToCent(importe.value);
      if (!cents || cents <= 0) return { error: 'Escribe el importe, por ejemplo 12,50.' };
      if (!concepto.value.trim()) return { error: 'Escribe el concepto.' };
      const res = await api('POST', '/api/tpv/caja/movimientos', { tipo, importe_cent: cents, concepto: concepto.value.trim() });
      return res.ok ? res.data : { error: res.error };
    },
  });
}

/** Resumen de la caja abierta: cuentas, movimientos y acciones. */
function pantallaResumen(zona, r, { user, recargar, salir, irVenta, denominaciones }) {
  const seccion = h('section', { class: 'cj' }, [
    h('div', { class: 'cj-cab' }, [
      h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }),
      h('h1', { class: 'cj-titulo', tabindex: '-1', text: 'Caja abierta' }),
      h('span', { class: 'cj-desde', text: `desde ${r.apertura} · ${r.abrio ?? ''}` }),
    ]),
    h('div', { class: 'cj-cols' }, [
      h('div', { class: 'cj-tarjeta' }, [
        h('h2', { text: 'Efectivo en caja' }),
        linea('Al abrir', formatEuros(r.inicial_cent)),
        linea('Ventas en efectivo', `+${formatEuros(r.ventas_efectivo_cent)}`),
        linea('Entradas', `+${formatEuros(r.entradas_cent)}`),
        linea('Salidas', `−${formatEuros(r.salidas_cent)}`),
        linea('Debe haber', formatEuros(r.esperado_cent), 'is-total'),
      ]),
      h('div', { class: 'cj-tarjeta' }, [
        h('h2', { text: `Ventas de esta caja (${r.tickets} tickets)` }),
        ...Object.keys(METODO).map((m) => linea(METODO[m], formatEuros(r.por_metodo[m] ?? 0))),
        linea('Total vendido', formatEuros(r.total_ventas_cent), 'is-total'),
      ]),
    ]),
    h('div', { class: 'cj-tarjeta' }, [
      h('h2', { text: 'Entradas y salidas de dinero' }),
      r.movimientos.length
        ? h('ul', { class: 'cj-movs' }, r.movimientos.map((m) => h('li', {}, [
          h('span', { text: `${m.hora} · ${m.concepto} · ${m.quien ?? ''}` }),
          h('strong', { class: m.tipo === 'entrada' ? 'is-entrada' : 'is-salida', text: `${m.tipo === 'entrada' ? '+' : '−'}${formatEuros(m.importe_cent)}` }),
        ])))
        : h('p', { class: 'cj-ayuda', text: 'Ninguna todavía.' }),
      h('div', { class: 'cj-botones' }, [
        h('button', { type: 'button', class: 'tpv-ghost', 'data-mov': 'entrada', text: '+ Entrada de dinero' }),
        h('button', { type: 'button', class: 'tpv-ghost', 'data-mov': 'salida', text: '− Salida de dinero' }),
      ]),
    ]),
    h('div', { class: 'cj-botones cj-final' }, [
      h('button', { type: 'button', class: 'vt-libre', 'data-vender': '', text: 'Ir a vender' }),
      h('button', { type: 'button', class: 'vt-cobrar cj-accion', 'data-cerrar': '', text: 'Arqueo y cierre de caja' }),
    ]),
  ]);
  zona.replaceChildren(seccion);
  seccion.addEventListener('click', async (e) => {
    if (e.target.closest('[data-salir]')) return void salir();
    if (e.target.closest('[data-vender]')) return void irVenta();
    const mov = e.target.closest('[data-mov]');
    if (mov && await pedirMovimiento(mov.dataset.mov)) {
      showToast('Apuntado.');
      return void recargar();
    }
    if (e.target.closest('[data-cerrar]')) return void pantallaCierre(zona, r, { user, recargar, salir, denominaciones });
    return undefined;
  });
  zona.querySelector('h1').focus();
}

/** Informe del cierre (para la pantalla y para imprimir en la térmica). */
function informeDom(r) {
  const fila = (izq, der, cls = '') => h('div', { class: `tk-fila ${cls}` }, [h('span', { text: izq }), h('span', { text: der })]);
  return h('div', { class: 'tk' }, [
    h('div', { class: 'tk-cab' }, [h('strong', { class: 'tk-nombre', text: r.tienda?.nombre ?? 'Puntapié' }), h('span', { text: 'Cierre de caja' })]),
    h('div', { class: 'tk-sep' }),
    fila('Apertura', `${r.apertura} · ${r.abrio ?? ''}`),
    fila('Cierre', `${r.cierre} · ${r.cerro ?? ''}`),
    h('div', { class: 'tk-sep' }),
    fila('Al abrir', formatEuros(r.inicial_cent)),
    fila('Ventas en efectivo', formatEuros(r.ventas_efectivo_cent)),
    fila('Entradas', formatEuros(r.entradas_cent)),
    fila('Salidas', formatEuros(r.salidas_cent)),
    fila('Debe haber', formatEuros(r.esperado_cent), 'tk-total'),
    fila('Contado', formatEuros(r.contado_cent), 'tk-total'),
    fila('Descuadre', firmado(r.diferencia_cent ?? 0)),
    h('div', { class: 'tk-sep' }),
    fila(`Tickets`, String(r.tickets)),
    ...Object.keys(METODO).map((m) => fila(METODO[m], formatEuros(r.por_metodo[m] ?? 0))),
    fila('Total vendido', formatEuros(r.total_ventas_cent), 'tk-total'),
  ]);
}

/** Arqueo: se cuenta el dinero; si no cuadra hace falta un Administrador. */
function pantallaCierre(zona, r, { user, recargar, salir, denominaciones }) {
  const dif = h('div', { class: 'cj-dif' });
  const cerrar = h('button', { class: 'vt-cobrar cj-accion', type: 'button', text: 'Cerrar caja' });
  const pintarDif = (contado) => {
    const d = contado - r.esperado_cent;
    dif.className = `cj-dif ${d === 0 ? 'is-ok' : 'is-mal'}`;
    dif.replaceChildren(
      linea('Debe haber', formatEuros(r.esperado_cent)),
      linea('Contado', formatEuros(contado)),
      linea(d === 0 ? 'Cuadra' : d > 0 ? 'Sobran' : 'Faltan', d === 0 ? '✓' : formatEuros(Math.abs(d)), 'is-total'),
    );
    cerrar.textContent = d === 0 || user.role === 'admin' ? 'Cerrar caja' : 'Cerrar caja (necesita aprobación)';
  };
  const rc = recuentoDinero(denominaciones, {}, pintarDif);
  zona.replaceChildren(h('section', { class: 'cj' }, [
    h('div', { class: 'cj-cab' }, [
      h('button', { class: 'tpv-ghost', type: 'button', 'data-volver': '', text: '← Caja' }),
      h('h1', { class: 'cj-titulo', tabindex: '-1', text: 'Arqueo y cierre' }),
    ]),
    h('p', { class: 'cj-ayuda', text: 'Cuenta todas las monedas y billetes que hay en la caja.' }),
    h('div', { class: 'cj-cols cj-cols-cierre' }, [rc.el, h('div', {}, [dif, cerrar])]),
  ]));
  zona.querySelector('[data-volver]').addEventListener('click', recargar);
  cerrar.addEventListener('click', async () => {
    const recuento = rc.leer();
    const d = rc.total() - r.esperado_cent;
    let aprobacion = null;
    if (d !== 0 && user.role !== 'admin') {
      aprobacion = await pedirAprobacion({
        titulo: 'La caja no cuadra',
        resumen: `${d > 0 ? 'Sobran' : 'Faltan'} ${formatEuros(Math.abs(d))}: debe haber ${formatEuros(r.esperado_cent)} y hay ${formatEuros(rc.total())}.`,
        ruta: '/api/tpv/caja',
        cuerpo: { recuento },
      });
      if (!aprobacion) return;
    } else if (d !== 0 && !window.confirm(`La caja no cuadra (${d > 0 ? 'sobran' : 'faltan'} ${formatEuros(Math.abs(d))}). ¿Cerrar igualmente?`)) return;
    const res = await api('POST', '/api/tpv/caja/cerrar', { recuento, aprobacion_id: aprobacion });
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    const informe = res.data;
    imprimir(informeDom(informe));
    zona.replaceChildren(h('section', { class: 'cj' }, [
      h('div', { class: 'cj-cab' }, [h('h1', { class: 'cj-titulo', tabindex: '-1', text: 'Caja cerrada' })]),
      h('div', { class: `cj-dif ${informe.diferencia_cent === 0 ? 'is-ok' : 'is-mal'}` }, [
        linea('Descuadre', informe.diferencia_cent === 0 ? 'Cuadra ✓' : firmado(informe.diferencia_cent), 'is-total'),
      ]),
      h('div', { class: 'cj-botones' }, [
        h('button', { type: 'button', class: 'tpv-ghost', 'data-reimprimir': '', text: 'Imprimir otra copia' }),
        h('button', { type: 'button', class: 'vt-libre', 'data-salir': '', text: 'Volver al inicio' }),
      ]),
      h('div', { class: 'vt-ticket-vista' }, informeDom(informe)),
    ]));
    zona.querySelector('[data-reimprimir]').addEventListener('click', () => imprimir(informeDom(informe)));
    zona.querySelector('[data-salir]').addEventListener('click', salir);
  });
  zona.querySelector('h1').focus();
}

/**
 * Abre la pantalla de caja en `zona`. `modo`: 'resumen' (o 'cierre' para ir
 * directo al arqueo). Si está cerrada, muestra la apertura y luego `alAbrir`.
 */
export async function renderCaja(zona, { user, salir, irVenta, modo = 'resumen', alAbrir = null }) {
  const res = await api('GET', '/api/tpv/caja');
  if (!res.ok) return void zona.replaceChildren(h('p', { class: 'cj-error', text: res.error }));
  const { denominaciones } = res.data;
  const recargar = () => renderCaja(zona, { user, salir, irVenta });
  if (!res.data.abierta) return void pantallaAbrir(zona, res.data, { salir, alAbrir: alAbrir ?? recargar });
  if (modo === 'cierre') return void pantallaCierre(zona, res.data.abierta, { user, recargar, salir, denominaciones });
  return void pantallaResumen(zona, res.data.abierta, { user, recargar, salir, irVenta, denominaciones });
}

/** ¿Está la caja abierta? (la venta lo comprueba antes de empezar) */
export async function cajaAbierta() {
  const res = await api('GET', '/api/tpv/caja');
  return res.ok && Boolean(res.data.abierta);
}
