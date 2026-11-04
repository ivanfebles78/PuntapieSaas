import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { eurToCent } from '../proveedores/util.js';

// Diálogos de la venta: descuento (de una línea o del ticket), artículo libre
// y aprobación de un descuento de más del 15 %.

// Los tipos vienen del catálogo (Admin › Catálogo); si no cargan, los de siempre.
const TIPOS_RESPALDO = Object.freeze([['calzado', 'Calzado'], ['ropa', 'Ropa'], ['accesorios', 'Accesorios'], ['juguetes', 'Juguetes']]);
async function tiposLibre() {
  const res = await api('GET', '/api/stock/tipos');
  return [['', 'Sin tipo'], ...(res.ok ? res.data.map((t) => [t.id, t.nombre]) : TIPOS_RESPALDO)];
}
const ESPERA_MS = 3000;

const campo = (id, label, control) => h('div', { class: 'field' }, [h('label', { for: id, text: label }), control]);

/** Descuento en % o en €. Resuelve { tipo, valor } (valor en céntimos si es €), null para quitarlo, o undefined si se cancela. */
export async function pedirDescuento({ titulo, actual, importe }) {
  const tipo = h('select', { id: 'dto-tipo' }, [
    h('option', { value: 'pct', text: '%', selected: actual?.tipo !== 'eur' }),
    h('option', { value: 'eur', text: '€', selected: actual?.tipo === 'eur' }),
  ]);
  const valor = h('input', {
    id: 'dto-valor', inputmode: 'decimal', autocomplete: 'off',
    value: actual ? (actual.tipo === 'eur' ? (actual.valor / 100).toFixed(2).replace('.', ',') : String(actual.valor).replace('.', ',')) : '',
  });
  const r = await openDialog({
    eyebrow: 'Descuento',
    title: titulo,
    lead: `Importe: ${formatEuros(importe)}. Hasta un 15 % lo puedes aplicar tú; más necesita la aprobación de un Administrador.${actual ? ' Déjalo vacío para quitarlo.' : ''}`,
    content: h('div', { class: 'tpvd-fila' }, [campo('dto-valor', 'Descuento', valor), campo('dto-tipo', 'En', tipo)]),
    submitLabel: 'Aplicar',
    onSubmit: async () => {
      const texto = valor.value.trim();
      if (!texto) return { quitar: true };
      const n = tipo.value === 'eur' ? eurToCent(texto) : Number(texto.replace(',', '.'));
      if (n == null || !Number.isFinite(n) || n <= 0) return { error: 'Escribe un descuento mayor que 0, por ejemplo 10 o 5,50.' };
      if (tipo.value === 'pct' && n > 100) return { error: 'Un descuento no puede pasar del 100 %.' };
      if (tipo.value === 'eur' && n > importe) return { error: 'El descuento no puede ser mayor que el importe.' };
      return { tipo: tipo.value, valor: n };
    },
  });
  if (r === null) return undefined; // cancelado: se queda como estaba
  if (r.quitar) return null;
  return r;
}

/** Artículo sin ficha en el stock (arreglo, plantillas, varios…). */
export async function pedirLibre({ precioSugerido = null, concepto = '' } = {}) {
  const tipos = await tiposLibre();
  const desc = h('input', { id: 'lib-desc', maxlength: '80', value: concepto, autocomplete: 'off' });
  const precio = h('input', { id: 'lib-precio', inputmode: 'decimal', autocomplete: 'off', value: precioSugerido ? (precioSugerido / 100).toFixed(2).replace('.', ',') : '' });
  const cantidad = h('input', { id: 'lib-cant', type: 'number', min: '1', max: '999', value: '1' });
  const tipo = h('select', { id: 'lib-tipo' }, tipos.map(([v, t]) => h('option', { value: v, text: t })));
  return openDialog({
    eyebrow: 'Artículo libre',
    title: 'Añadir sin ficha',
    lead: 'Para lo que no está en el stock: no resta existencias, pero cuenta en la venta y en las estadísticas.',
    content: h('div', { class: 'tpvd-grid' }, [
      campo('lib-desc', 'Concepto', desc), campo('lib-precio', 'Precio (€)', precio),
      campo('lib-cant', 'Cantidad', cantidad), campo('lib-tipo', 'Tipo', tipo),
    ]),
    submitLabel: 'Añadir',
    onSubmit: async () => {
      const p = eurToCent(precio.value);
      if (!desc.value.trim()) return { error: 'Escribe el concepto.' };
      if (p == null || p <= 0) return { error: 'Escribe el precio, por ejemplo 12,50.' };
      const n = Number(cantidad.value);
      if (!Number.isInteger(n) || n < 1 || n > 999) return { error: 'Cantidad no válida.' };
      return { descripcion: desc.value.trim(), precio_cent: p, cantidad: n, tipo: tipo.value || null };
    },
  });
}

/** PVP para un artículo que no lo tiene puesto en el stock. */
export function pedirPrecio(nombre) {
  const precio = h('input', { id: 'pvp-tpv', inputmode: 'decimal', autocomplete: 'off' });
  return openDialog({
    eyebrow: 'Sin PVP',
    title: nombre,
    lead: 'Este artículo no tiene PVP en el stock. Escribe el precio de venta (luego ponlo en Inventario).',
    content: campo('pvp-tpv', 'PVP (€)', precio),
    submitLabel: 'Añadir',
    onSubmit: async () => {
      const p = eurToCent(precio.value);
      return p && p > 0 ? p : { error: 'Escribe el precio, por ejemplo 59,95.' };
    },
  });
}

/**
 * Aprobación de un Administrador (descuento de más del 15 % o cierre de caja
 * que no cuadra): está en la tienda (usuario y contraseña) o se le pide por
 * WhatsApp y se espera su respuesta. `ruta` = '/api/tpv' o '/api/tpv/caja';
 * `cuerpo` = lo que se aprueba ({ venta } o { recuento }). Resuelve el id o null.
 */
export async function pedirAprobacion({ titulo, resumen, ruta, cuerpo }) {
  const usuario = h('input', { id: 'apr-user', autocomplete: 'off', spellcheck: 'false' });
  const contrasena = h('input', { id: 'apr-pass', type: 'password', autocomplete: 'off' });
  const estado = h('p', { class: 'tpvd-estado', 'aria-live': 'polite' });
  let solicitud = null;
  let espera = null;
  const parar = () => clearInterval(espera);

  const whatsapp = h('button', { type: 'button', class: 'pbtn tpvd-wa', text: 'El Administrador no está: pedirlo por WhatsApp' });
  const contenido = h('div', {}, [
    h('p', { class: 'tpvd-pct', text: resumen }),
    h('div', { class: 'tpvd-grid' }, [campo('apr-user', 'Usuario o correo del Administrador', usuario), campo('apr-pass', 'Contraseña', contrasena)]),
    whatsapp,
    estado,
  ]);

  let resolverRemoto;
  const remoto = new Promise((r) => { resolverRemoto = r; });
  whatsapp.addEventListener('click', async () => {
    whatsapp.disabled = true;
    const res = await api('POST', `${ruta}/aprobaciones`, cuerpo);
    if (!res.ok) {
      whatsapp.disabled = false;
      estado.textContent = res.error;
      return;
    }
    solicitud = res.data;
    if (res.data.enlace_whatsapp) window.open(res.data.enlace_whatsapp, '_blank', 'noopener');
    estado.textContent = res.data.enviado ? 'Aviso enviado por WhatsApp. Esperando la respuesta…' : 'Envía el mensaje de WhatsApp que se ha abierto. Esperando la respuesta…';
    espera = setInterval(async () => {
      const s = await api('GET', `/api/tpv/aprobaciones/${solicitud.id}`);
      if (!s.ok || s.data.estado === 'pendiente') return;
      parar();
      if (s.data.estado === 'aprobado') {
        estado.textContent = `Aprobado por ${s.data.decidido_por}.`;
        resolverRemoto(s.data.id);
      } else {
        estado.textContent = s.data.estado === 'rechazado' ? `${s.data.decidido_por ?? 'El Administrador'} lo ha rechazado.` : 'La solicitud ha caducado.';
        whatsapp.disabled = false;
      }
    }, ESPERA_MS);
  });

  const dialogo = openDialog({
    eyebrow: 'Necesita aprobación',
    title: titulo,
    lead: 'Un Administrador tiene que aprobarlo: aquí mismo con su usuario y contraseña, o a distancia.',
    content: contenido,
    submitLabel: 'Aprobar aquí',
    onSubmit: async () => {
      if (!usuario.value.trim() || !contrasena.value) return { error: 'Escribe el usuario y la contraseña del Administrador.' };
      const res = await api('POST', `${ruta}/aprobaciones/presencial`, { ...cuerpo, usuario: usuario.value.trim(), contrasena: contrasena.value });
      contrasena.value = '';
      return res.ok ? { id: res.data.id } : { error: res.error };
    },
  });
  // Lo que llegue antes: la aprobación en persona o la respuesta del WhatsApp.
  const id = await Promise.race([
    dialogo.then((r) => r?.id ?? null),
    remoto.then((r) => { contenido.closest('dialog')?.close(); return r; }),
  ]);
  parar();
  return id;
}
