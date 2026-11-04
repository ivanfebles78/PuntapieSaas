import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { showToast } from '../toast.js';
import { modelosDom, tallaPulsada } from './articulos.js';

// TPV › Reservas: productos apartados sin pagar para un cliente, unos días
// (7 como mucho, por defecto). Lo reservado no se vende a otro cliente; al
// vencer vuelve a estar disponible solo. Del cliente basta un nombre y, si
// quiere que le avisen, su móvil. Se cobra con «Vender», que abre la venta
// con los productos ya puestos.

const FILTROS = Object.freeze([['activas', 'Activas'], ['cerradas', 'Cerradas'], ['todas', 'Todas']]);
const CERRADAS = Object.freeze({ vendida: 'Vendida', cancelada: 'Anulada', caducada: 'Caducada' });
const BUSCAR_TRAS_MS = 300;
const TZ = 'Atlantic/Canary';

const campo = (id, label, control) => h('div', { class: 'field' }, [h('label', { for: id, text: label }), control]);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const talla = (l) => (l.talla && l.talla !== 'Única' ? ` · T. ${l.talla}` : '');

/** «2026-11-11» → «mié 11 nov». */
function diaCorto(iso) {
  return new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${iso}T12:00:00Z`)).replace(/\./g, '');
}

/** Fecha en que vencería una reserva hecha hoy con `dias` días. */
function venceCon(dias) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function plazo(r) {
  if (r.estado !== 'activa') return { texto: CERRADAS[r.estado] ?? r.estado, tono: r.estado };
  if (r.dias_restantes <= 0) return { texto: 'Vence hoy', tono: 'urgente' };
  if (r.dias_restantes === 1) return { texto: 'Vence mañana', tono: 'pronto' };
  return { texto: `Quedan ${r.dias_restantes} días`, tono: 'activa' };
}

/** Enlace de WhatsApp con el recordatorio escrito (lo envía quien atiende). */
function enlaceWhatsapp(r) {
  const digitos = r.telefono.replace(/^\+/, '');
  const numero = digitos.length === 9 ? `34${digitos}` : digitos;
  const que = r.lineas.map((l) => `${l.cantidad > 1 ? `${l.cantidad} × ` : ''}${l.marca} ${l.modelo}${talla(l)}`).join(', ');
  const texto = `Hola, ${r.nombre}: te recordamos que en Puntapié tienes reservado ${que} hasta el ${diaCorto(r.hasta)}. ¡Te esperamos!`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

function anular(r) {
  const motivo = h('input', { id: 'rs-motivo', maxlength: '120', autocomplete: 'off', placeholder: 'Opcional' });
  return openDialog({
    eyebrow: `Reserva ${r.id}`, title: 'Anular la reserva',
    lead: `Los productos vuelven a estar disponibles para vender. ${r.nombre} no podrá recogerlos con esta reserva.`,
    submitLabel: 'Anular reserva',
    content: [campo('rs-motivo', 'Motivo', motivo)],
    onSubmit: async () => {
      const res = await api('POST', `/api/reservas/${r.id}/anular`, { motivo: motivo.value });
      return res.ok ? true : { error: res.error };
    },
  });
}

function prorrogar(r, diasMax) {
  const dias = h('select', { id: 'rs-pdias' }, Array.from({ length: diasMax }, (_, i) => i + 1)
    .map((n) => h('option', { value: String(n), text: `${plural(n, 'día', 'días')} · hasta el ${diaCorto(venceCon(n))}`, selected: n === diasMax })));
  return openDialog({
    eyebrow: `Reserva ${r.id}`, title: r.estado === 'caducada' ? 'Reactivar la reserva' : 'Prorrogar la reserva',
    lead: r.estado === 'caducada'
      ? `Venció el ${diaCorto(r.hasta)}. Se vuelve a apartar si los productos siguen libres; los días se cuentan desde hoy.`
      : `Ahora vence el ${diaCorto(r.hasta)}. Se cuentan los días desde hoy.`,
    submitLabel: r.estado === 'caducada' ? 'Reactivar' : 'Prorrogar',
    content: [campo('rs-pdias', 'Nuevo plazo', dias)],
    onSubmit: async () => {
      const res = await api('POST', `/api/reservas/${r.id}/prorrogar`, { dias: Number(dias.value) });
      return res.ok ? true : { error: res.error };
    },
  });
}

/** Pantalla para apartar productos: buscar a la izquierda, la reserva a la derecha. */
function nuevaReserva(zona, { diasMax, volver }) {
  let lineas = [];
  let temporizador = null;
  const buscador = h('input', {
    class: 'vt-buscar', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Escanea o escribe código, referencia o modelo…', 'aria-label': 'Buscar el producto que se reserva',
  });
  const resultados = h('div', { class: 'vt-resultados', 'aria-live': 'polite' }, ayuda());
  const lista = h('ol', { class: 'vt-lineas' });
  const nombre = h('input', { id: 'rs-nombre', maxlength: '60', autocomplete: 'off', placeholder: 'Basta con el nombre' });
  const telefono = h('input', { id: 'rs-tel', type: 'tel', inputmode: 'tel', maxlength: '20', autocomplete: 'off', placeholder: 'Opcional, para avisarle' });
  const dias = h('select', { id: 'rs-dias' }, Array.from({ length: diasMax }, (_, i) => i + 1)
    .map((n) => h('option', { value: String(n), text: `${plural(n, 'día', 'días')} · hasta el ${diaCorto(venceCon(n))}`, selected: n === diasMax })));
  const notas = h('input', { id: 'rs-notas', maxlength: '200', autocomplete: 'off', placeholder: 'Opcional' });
  const guardar = h('button', { class: 'vt-cobrar', type: 'button', 'data-guardar': '', disabled: true, text: 'Reservar' });

  function ayuda(texto = null) {
    return h('div', { class: 'vt-ayuda' }, [
      h('strong', { text: texto ?? 'Busca el producto que se aparta' }),
      h('span', { text: 'Solo se reserva lo que hay en la tienda y no está reservado ya.' }),
    ]);
  }

  const raiz = h('div', { class: 'vt' }, [
    h('section', { class: 'vt-izq' }, [
      h('div', { class: 'vt-barra' }, [h('button', { class: 'tpv-ghost', type: 'button', 'data-volver': '', text: '← Reservas' }), buscador]),
      resultados,
    ]),
    h('section', { class: 'vt-ticket', 'aria-label': 'Reserva en curso' }, [
      h('div', { class: 'vt-ticket-cab' }, [h('h2', { text: 'Nueva reserva' })]),
      lista,
      h('div', { class: 'rs-form' }, [
        campo('rs-nombre', 'Nombre del cliente', nombre),
        campo('rs-tel', 'Móvil', telefono),
        campo('rs-dias', 'Se guarda', dias),
        campo('rs-notas', 'Notas', notas),
      ]),
      h('p', { class: 'rs-nota', text: 'No se cobra nada. Si no viene, al vencer los productos vuelven a estar a la venta.' }),
      guardar,
    ]),
  ]);

  const enfocar = () => setTimeout(() => buscador.focus(), 0);

  function pintar() {
    lista.replaceChildren(...(lineas.length ? lineas.map((l, i) => h('li', { class: 'vt-linea rs-linea' }, [
      h('div', { class: 'vt-l-desc' }, [h('strong', { text: l.descripcion }), h('span', { text: [l.talla && l.talla !== 'Única' ? `Talla ${l.talla}` : null, l.pvp_cent != null ? formatEuros(l.pvp_cent) : null].filter(Boolean).join(' · ') })]),
      h('div', { class: 'vt-l-cant' }, [
        h('button', { type: 'button', 'data-menos': String(i), 'aria-label': 'Una menos', text: '−' }),
        h('span', { text: String(l.cantidad) }),
        h('button', { type: 'button', 'data-mas': String(i), 'aria-label': 'Una más', text: '+' }),
      ]),
      h('button', { type: 'button', class: 'vt-l-quitar', 'data-quitar': String(i), 'aria-label': `Quitar ${l.descripcion}`, text: '✕' }),
    ])) : [h('li', { class: 'vt-vacio', text: 'Aún no hay productos.' })]));
    guardar.disabled = !lineas.length;
    const unidades = lineas.reduce((s, l) => s + l.cantidad, 0);
    guardar.textContent = unidades ? `Reservar ${plural(unidades, 'producto', 'productos')}` : 'Reservar';
  }

  function anadir(art) {
    const libres = art.stock - (art.reservado ?? 0);
    const ya = lineas.find((l) => l.articulo_id === art.id);
    if ((ya?.cantidad ?? 0) + 1 > libres) {
      showToast(libres > 0 ? `De esa talla solo ${libres === 1 ? 'queda 1 libre' : `quedan ${libres} libres`}.` : 'Esa talla no está libre (sin stock o ya reservada).', { tone: 'error' });
      return enfocar();
    }
    if (ya) ya.cantidad += 1;
    else {
      lineas = [...lineas, {
        articulo_id: art.id, cantidad: 1, talla: art.talla, pvp_cent: art.pvp_cent, libres,
        descripcion: [art.marca, art.modelo !== art.referencia ? art.modelo : null, art.referencia, art.color].filter(Boolean).join(' · '),
      }];
    }
    pintar();
    return enfocar();
  }

  async function buscar(consulta) {
    const q = consulta.trim();
    if (!q) return void resultados.replaceChildren(ayuda());
    const res = await api('GET', `/api/tpv/buscar?q=${encodeURIComponent(q)}`);
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    if (res.data.exacto) {
      buscador.value = '';
      resultados.replaceChildren(ayuda(`Añadido: ${res.data.exacto.marca} ${res.data.exacto.referencia} · T. ${res.data.exacto.talla}`));
      return void anadir(res.data.exacto);
    }
    if (!res.data.modelos.length) return void resultados.replaceChildren(ayuda(`No hay nada con «${q}»`));
    resultados.replaceChildren(...modelosDom(res.data.modelos));
    resultados.dataset.modelos = JSON.stringify(res.data.modelos);
    return undefined;
  }

  async function reservar() {
    if (nombre.value.trim().length < 2) {
      showToast('Escribe el nombre del cliente.', { tone: 'error' });
      return void nombre.focus();
    }
    guardar.disabled = true;
    const res = await api('POST', '/api/reservas', {
      nombre: nombre.value, telefono: telefono.value, dias: Number(dias.value), notas: notas.value,
      lineas: lineas.map((l) => ({ articulo_id: l.articulo_id, cantidad: l.cantidad })),
    });
    guardar.disabled = false;
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    showToast(`Reservado para ${res.data.nombre} hasta el ${diaCorto(res.data.hasta)}.`);
    return void volver();
  }

  buscador.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(temporizador);
    buscar(buscador.value);
  });
  buscador.addEventListener('input', () => {
    clearTimeout(temporizador);
    const q = buscador.value.trim();
    if (q.length < 3 || /^\d+$/.test(q)) return;
    temporizador = setTimeout(() => buscar(q), BUSCAR_TRAS_MS);
  });
  raiz.addEventListener('click', (e) => {
    const t = e.target;
    const g = t.closest('[data-g]');
    if (g) {
      const art = tallaPulsada(resultados, g);
      if (art) anadir(art);
      return;
    }
    const n = (attr) => Number(t.closest(`[data-${attr}]`)?.dataset[attr]);
    if (t.closest('[data-mas]')) {
      const l = lineas[n('mas')];
      if (l.cantidad + 1 > l.libres) showToast('No quedan más unidades libres de esa talla.', { tone: 'error' });
      else lineas = lineas.map((x) => (x === l ? { ...x, cantidad: x.cantidad + 1 } : x));
      pintar();
    } else if (t.closest('[data-menos]')) {
      const i = n('menos');
      lineas = lineas[i].cantidad > 1 ? lineas.map((x, j) => (j === i ? { ...x, cantidad: x.cantidad - 1 } : x)) : lineas.filter((_, j) => j !== i);
      pintar();
    } else if (t.closest('[data-quitar]')) {
      lineas = lineas.filter((_, j) => j !== n('quitar'));
      pintar();
    } else if (t.closest('[data-guardar]')) reservar();
    else if (t.closest('[data-volver]')) {
      if (lineas.length && !window.confirm('La reserva no está guardada. ¿Salir y perderla?')) return;
      volver();
    }
  });

  pintar();
  zona.replaceChildren(raiz);
  enfocar();
}

/** Pinta TPV › Reservas. `vender(reserva)` abre la venta con sus productos. */
export function renderReservas(zona, { user, salir, vender }) {
  let filtro = 'activas';
  let datos = null;
  const esAdmin = user.role === 'admin';
  const vende = esAdmin || user.role === 'empleado';

  const resumen = h('div', { class: 'gr-resumen' });
  const filtros = h('div', { class: 'cb-modos', role: 'group', 'aria-label': 'Qué reservas' },
    FILTROS.map(([id, texto]) => h('button', { type: 'button', 'data-filtro': id, text: texto })));
  const lista = h('div', { class: 'gr-lista', 'aria-live': 'polite' });
  const ayudaTxt = h('p', { class: 'cj-ayuda', text: 'Se aparta sin pagar. Lo reservado no se vende a otro cliente; al vencer vuelve a estar a la venta.' });

  const raiz = h('div', { class: 'gr' }, [
    h('div', { class: 'vt-barra' }, [
      h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }),
      h('h1', { class: 'gr-titulo', tabindex: '-1', text: 'Reservas' }),
      vende ? h('button', { class: 'vt-libre', type: 'button', 'data-nueva': '', text: '+ Nueva reserva' }) : '',
    ]),
    ayudaTxt,
    h('div', { class: 'cb-barra2' }, [filtros, resumen]),
    lista,
  ]);

  const tarjeta = (r) => {
    const p = plazo(r);
    const puedeVender = vende && (r.estado === 'activa' || r.estado === 'caducada') && !r.ticket && !r.datos_borrados;
    const reactivable = esAdmin && r.estado === 'caducada' && !r.datos_borrados;
    return h('article', { class: `rs-res is-${p.tono}` }, [
      h('div', { class: 'rs-cab' }, [
        h('span', { class: 'gr-badge', text: p.texto }),
        h('strong', { class: 'rs-nombre', text: r.nombre }),
        h('span', { class: 'rs-hasta', text: r.estado === 'activa' ? `hasta el ${diaCorto(r.hasta)}` : r.cerrada ?? '' }),
      ]),
      h('ul', { class: 'rs-prods' }, r.lineas.map((l) => h('li', {}, [
        h('span', { text: `${l.cantidad} × ${l.descripcion}${talla(l)}` }),
        l.pvp_cent != null ? h('strong', { text: formatEuros(l.pvp_cent * l.cantidad) }) : '',
      ]))),
      h('p', { class: 'gr-meta', text: [
        `Nº ${r.id}`, `reservada el ${r.creada}${r.por ? ` por ${r.por}` : ''}`, r.telefono, r.prorrogas ? plural(r.prorrogas, 'prórroga', 'prórrogas') : null,
        r.ticket ? `ticket ${r.ticket}` : null, r.motivo ? `motivo: ${r.motivo}` : null, r.notas || null,
      ].filter(Boolean).join(' · ') }),
      puedeVender || reactivable || (r.estado === 'activa' && vende) ? h('div', { class: 'vt-hecha-acciones' }, [
        puedeVender ? h('button', { type: 'button', class: 'vt-libre', 'data-vender': String(r.id), text: r.estado === 'caducada' ? 'Vender igualmente' : `Vender${r.total_cent != null ? ` · ${formatEuros(r.total_cent)}` : ''}` }) : '',
        r.estado === 'activa' && r.telefono ? h('a', { class: 'tpv-ghost', href: enlaceWhatsapp(r), target: '_blank', rel: 'noopener', text: 'Avisar por WhatsApp' }) : '',
        (r.estado === 'activa' && esAdmin) || reactivable
          ? h('button', { type: 'button', class: 'tpv-ghost', 'data-prorrogar': String(r.id), text: r.estado === 'caducada' ? 'Reactivar' : 'Prorrogar' }) : '',
        r.estado === 'activa' && vende ? h('button', { type: 'button', class: 'tpv-ghost', 'data-anular': String(r.id), text: 'Anular' }) : '',
      ]) : '',
    ]);
  };

  function pintar() {
    filtros.querySelectorAll('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === filtro)));
    if (!datos) return;
    const t = datos.totales;
    ayudaTxt.textContent = `Se aparta sin pagar, ${plural(datos.dias_max, 'día', 'días')} como mucho. Lo reservado no se vende a otro cliente; al vencer vuelve a estar a la venta.`;
    resumen.replaceChildren(
      h('span', {}, [h('strong', { text: String(t.activas) }), ` ${t.activas === 1 ? 'activa' : 'activas'}`]),
      h('span', { class: t.vencen_hoy ? 'is-urgente' : '' }, [h('strong', { text: String(t.vencen_hoy) }), ' vencen hoy']),
      h('span', {}, [h('strong', { text: String(t.vencen_manana) }), ' mañana']),
    );
    lista.replaceChildren(...(datos.items.length ? datos.items.map(tarjeta) : [h('div', { class: 'vt-ayuda' }, [
      h('strong', { text: filtro === 'activas' ? 'No hay reservas activas' : 'No hay reservas' }),
      h('span', { text: vende ? 'Con «+ Nueva reserva» se aparta un producto para un cliente.' : 'Las crean quienes venden.' }),
    ])]));
  }

  async function cargar() {
    const r = await api('GET', `/api/reservas?estado=${filtro}`);
    if (!r.ok) return void lista.replaceChildren(h('div', { class: 'vt-ayuda' }, [h('strong', { text: r.error })]));
    datos = r.data;
    return pintar();
  }

  const porId = (id) => datos.items.find((i) => i.id === Number(id));
  const tras = async (hecho) => { if (hecho) await cargar(); };
  const volver = () => {
    zona.replaceChildren(raiz);
    cargar();
    raiz.querySelector('h1').focus();
  };

  raiz.addEventListener('click', async (e) => {
    const t = e.target;
    const f = t.closest('[data-filtro]');
    if (f) { filtro = f.dataset.filtro; return void cargar(); }
    if (t.closest('[data-nueva]')) return void nuevaReserva(zona, { diasMax: datos?.dias_max ?? 7, volver });
    const v = t.closest('[data-vender]');
    if (v) return void vender(porId(v.dataset.vender));
    const an = t.closest('[data-anular]');
    if (an) return void tras(await anular(porId(an.dataset.anular)));
    const pr = t.closest('[data-prorrogar]');
    if (pr) return void tras(await prorrogar(porId(pr.dataset.prorrogar), datos.dias_max));
    if (t.closest('[data-salir]')) return void salir();
    return undefined;
  });

  zona.replaceChildren(raiz);
  pintar();
  cargar();
  raiz.querySelector('h1').focus();
  return raiz;
}
