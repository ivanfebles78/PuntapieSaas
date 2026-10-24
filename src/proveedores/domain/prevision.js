// Previsión de pagos: agrupa los vencimientos pendientes por mes natural.
// Función pura para poder probarla sin base de datos.

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function claveMes(fechaIso) {
  return fechaIso.slice(0, 7);
}

export function etiquetaMes(clave) {
  const [y, m] = clave.split('-').map(Number);
  return `${MESES[m - 1]} ${y}`;
}

export function sumarMeses(clave, n) {
  const [y, m] = clave.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * @param {{ fecha: string, importe_cent: number }[]} pendientes vencimientos sin pagar
 * @param {{ hoy: string, meses?: number }} opts
 */
export function calcularPrevision(pendientes, { hoy, meses = 3 }) {
  const mesActual = claveMes(hoy);
  const ordenados = [...pendientes].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const vencidos = ordenados.filter((v) => v.fecha < hoy);
  const bloques = [];
  for (let i = 0; i < meses; i += 1) {
    const clave = sumarMeses(mesActual, i);
    const items = ordenados.filter((v) => claveMes(v.fecha) === clave && v.fecha >= hoy);
    bloques.push({ mes: clave, etiqueta: etiquetaMes(clave), total_cent: suma(items), items });
  }
  const limite = sumarMeses(mesActual, meses);
  const posteriores = ordenados.filter((v) => v.fecha >= hoy && claveMes(v.fecha) >= limite);
  return {
    hoy,
    vencidos: { total_cent: suma(vencidos), items: vencidos },
    meses: bloques,
    posteriores: { total_cent: suma(posteriores), items: posteriores },
    total_pendiente_cent: suma(ordenados),
  };
}

function suma(items) {
  return items.reduce((s, v) => s + v.importe_cent, 0);
}
