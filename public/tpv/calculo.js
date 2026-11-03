// Compartido: lo usa la pantalla del TPV y el servidor lo importa para validar la venta.
// Cálculo de una venta del TPV: importes por línea, descuentos (por línea y al
// total, en % o en €) y el porcentaje de descuento que cuenta para la regla
// del 15 %: el mayor entre el de cualquier línea y el del ticket entero.

export const DESCUENTO_LIBRE_MAX = 15; // % que puede poner quien vende sin aprobación
const MAX_CENTS = 10_000_000;

function descuentoDe(bruto, d) {
  if (!d || d.valor === '' || d.valor == null) return 0;
  const v = Number(d.valor);
  if (!Number.isFinite(v) || v < 0) throw new RangeError('descuento no válido');
  const cents = d.tipo === 'eur' ? Math.round(v) : Math.round((bruto * v) / 100);
  if (d.tipo !== 'eur' && v > 100) throw new RangeError('un descuento no puede pasar del 100 %');
  if (cents > bruto) throw new RangeError('el descuento no puede ser mayor que el importe');
  return cents;
}

const pct = (parte, todo) => (todo > 0 ? Math.round((parte / todo) * 1000) / 10 : 0); // con un decimal

/**
 * `lineas`: [{ precio_cent, cantidad, descuento?: { tipo: 'pct' | 'eur', valor } }]
 * (en € el valor va en céntimos). `descuento`: el del ticket, igual.
 * Devuelve las líneas con bruto, descuento (el suyo más su parte del de ticket)
 * y total, y los totales del ticket con el % efectivo.
 */
export function calcularVenta(lineas, descuento = null) {
  if (!Array.isArray(lineas) || !lineas.length) throw new RangeError('la venta no tiene productos');
  const base = lineas.map((l) => {
    const precio = Number(l.precio_cent);
    const cantidad = Number(l.cantidad);
    if (!Number.isInteger(precio) || precio < 0 || precio > MAX_CENTS) throw new RangeError('precio no válido');
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) throw new RangeError('cantidad no válida');
    const bruto = precio * cantidad;
    const propio = descuentoDe(bruto, l.descuento);
    return { bruto, propio, neto: bruto - propio };
  });
  const subtotal = base.reduce((s, l) => s + l.bruto, 0);
  const sumaNetos = base.reduce((s, l) => s + l.neto, 0);
  const delTicket = descuentoDe(sumaNetos, descuento);
  // El descuento del ticket se reparte entre las líneas según su importe (la última se lleva el redondeo).
  let repartido = 0;
  const resultado = base.map((l, i) => {
    const parte = i === base.length - 1 ? delTicket - repartido
      : sumaNetos > 0 ? Math.round((delTicket * l.neto) / sumaNetos) : 0;
    repartido += parte;
    const d = lineas[i].descuento;
    const pctPropio = d?.tipo === 'pct' && d.valor !== '' && d.valor != null ? Number(d.valor) : pct(l.propio, l.bruto);
    return { ...lineas[i], bruto_cent: l.bruto, descuento_cent: l.propio + parte, total_cent: l.neto - parte, pct_propio: pctPropio };
  });
  const total = sumaNetos - delTicket;
  const descuentoTotal = subtotal - total;
  const pctEfectivo = Math.max(pct(descuentoTotal, subtotal), ...resultado.map((l) => l.pct_propio));
  // La regla se mira en céntimos, con medio céntimo de margen por cada redondeo:
  // un 15 % exacto nunca pide aprobación aunque al redondear salga 15,02 %.
  const limite = (importe, redondeos) => Math.round((importe * DESCUENTO_LIBRE_MAX) / 100) + redondeos;
  const excede = base.some((l, i) => (lineas[i].descuento?.tipo === 'pct' ? Number(lineas[i].descuento.valor) > DESCUENTO_LIBRE_MAX : l.propio > limite(l.bruto, 0)))
    || descuentoTotal > limite(subtotal, base.length + 1);
  return {
    lineas: resultado, subtotal_cent: subtotal, descuento_cent: descuentoTotal, total_cent: total,
    pct_descuento: pctEfectivo, requiere_aprobacion: excede,
  };
}
