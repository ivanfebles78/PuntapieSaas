// Cálculo del estado de un documento a partir de sus vencimientos y pagos.
// Funciones puras: reciben datos ya cargados y no tocan la base de datos.

export const ESTADOS_FACTURA = ['pendiente', 'parcial', 'vencida', 'pagada'];
export const ESTADOS_PEDIDO = ['pendiente', 'facturado', 'recibido', 'cancelado'];

/**
 * @param {{ tipo: string, estado_manual?: string|null }} doc
 * @param {{ fecha: string, pago?: object|null }[]} vencimientos
 * @param {{ hoy: string, facturado?: boolean }} ctx
 */
export function calcularEstado(doc, vencimientos, { hoy, facturado = false }) {
  if (doc.tipo === 'pedido') {
    if (doc.estado_manual === 'recibido' || doc.estado_manual === 'cancelado') return doc.estado_manual;
    return facturado ? 'facturado' : 'pendiente';
  }
  if (vencimientos.length === 0) return 'pendiente';
  const pagados = vencimientos.filter((v) => v.pago).length;
  if (pagados === vencimientos.length) return 'pagada';
  if (vencimientos.some((v) => !v.pago && v.fecha < hoy)) return 'vencida';
  return pagados > 0 ? 'parcial' : 'pendiente';
}

/** Fecha ISO de hoy en la zona horaria local. */
export function hoyIso(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Importe pendiente de una factura (vencimientos sin pago). */
export function importePendiente(vencimientos) {
  return vencimientos.filter((v) => !v.pago).reduce((s, v) => s + v.importe_cent, 0);
}
