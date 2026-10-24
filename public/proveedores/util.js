import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Utilidades del gestor de pagos a proveedores (portadas de «Control de facturas»).

export const API = '/api/proveedores';
export const DIAS_URGENTE = 7;
export const eur = (cent) => formatEuros(cent ?? 0);
export const fecha = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' }).format(new Date());

const DAY_MS = 86400000;
export const diasHasta = (iso, hoyIso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${hoyIso}T00:00:00Z`)) / DAY_MS);
export const esVencido = (v, hoyIso) => !v.pago && v.fecha < hoyIso;
export const esUrgente = (v, hoyIso) => !v.pago && v.fecha >= hoyIso && diasHasta(v.fecha, hoyIso) <= DIAS_URGENTE;

export function etiquetaVto(v, hoyIso) {
  const d = diasHasta(v.fecha, hoyIso);
  if (d < 0) return d === -1 ? 'venció ayer' : `hace ${-d} días`;
  if (d === 0) return 'vence hoy';
  return d === 1 ? 'mañana' : `en ${d} días`;
}

/** Clase de color de un vencimiento: pagado, vencido, urgente (≤ 7 días) o normal. */
export function claseVto(v, hoyIso) {
  if (v.pago) return 'vto-pagado';
  if (esVencido(v, hoyIso)) return 'vto-vencido';
  if (esUrgente(v, hoyIso)) return 'vto-urgente';
  return 'vto-pendiente';
}

export const ESTADO_TXT = Object.freeze({
  pendiente: 'Pendiente', parcial: 'Parcial', vencida: 'Vencida', pagada: 'Pagada',
  facturado: 'Facturado', recibido: 'Recibido', cancelado: 'Cancelado',
  factura: 'Factura', pedido: 'Pedido', 'conf-alta': 'Confianza alta', 'conf-media': 'Confianza media', 'conf-baja': 'Revisar',
});

export const badge = (estado) => h('span', { class: `sbadge sb-${estado}`, text: ESTADO_TXT[estado] ?? estado });

/** «1.234,56» o «1234.5» → céntimos (null si no es un número). */
export function eurToCent(text) {
  const clean = String(text ?? '').trim().replace(/\s|€/g, '');
  if (!clean) return null;
  const normal = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const value = Number(normal);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export const centToEur = (cent) => (cent == null ? '' : (cent / 100).toFixed(2).replace('.', ','));

/** Sube un archivo en crudo (cuerpo = archivo, nombre en X-File-Name). */
export async function subir(path, file) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || (file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/pdf'), 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
  } catch {
    return { ok: false, error: 'No hay conexión con el servidor. Inténtalo de nuevo.' };
  }
  const json = await res.json().catch(() => ({ ok: false, error: 'Respuesta no válida del servidor.' }));
  return { status: res.status, ...json };
}

/** Pide uno o varios archivos al usuario. */
export function elegirArchivos({ accept = '.pdf,application/pdf', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Enlace a un PDF o justificante (se abre en otra pestaña). */
export const fileLink = (href, text, extra = '') => h('a', { class: `pbtn pbtn-sm ${extra}`, href, target: '_blank', rel: 'noopener', text });

/** Botón que cambia datos: el Asesor (solo consulta) no lo ve. */
export function writeBtn(text, attrs = {}, extra = '') {
  return h('button', { class: `pbtn ${extra}`, type: 'button', 'data-write': '', ...attrs, text });
}

/** Referencia de pedido comparable: sin signos ni ceros a la izquierda. */
export function normalizarRef(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9Ñ]/g, '').replace(/^0+(?=\d)/, '');
}

export const soloConsulta = () => document.body.classList.contains('is-readonly');
