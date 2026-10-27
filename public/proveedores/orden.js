// Orden de la lista de facturas. Sin DOM, para poder probarlo en Node.

/** Vencimiento con el que se ordena: el próximo sin pagar o, si ya está pagada, el último. */
const vtoOrden = (d) => d.proximo_vencimiento ?? d.vencimientos.at(-1)?.fecha ?? d.fecha ?? '';

/**
 * Por vencimiento: primero las que tienen algo por pagar, del vencimiento más
 * cercano (o ya pasado) al más lejano; las pagadas, al final. «fecha» deja el
 * orden del servidor (fecha de factura, la más reciente arriba).
 */
export function ordenarFacturas(docs, orden = 'vencimiento') {
  if (orden === 'fecha') return docs;
  const pagada = (d) => (d.proximo_vencimiento ? 0 : 1);
  return [...docs].sort((a, b) => pagada(a) - pagada(b) || vtoOrden(a).localeCompare(vtoOrden(b)) || a.id - b.id);
}
