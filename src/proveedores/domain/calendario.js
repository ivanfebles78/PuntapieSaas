// Calendario de pagos: reparte los vencimientos en una rejilla mensual (semanas de lunes a domingo).
// Función pura, sin base de datos ni PDF, para poder probarla con datos sueltos.
import { claveMes, etiquetaMes, sumarMeses } from './prevision.js';

export const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const MESES_VALIDOS = [3, 6, 9];

/** Número de días del mes "YYYY-MM". */
export function diasDelMes(clave) {
  const [y, m] = clave.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Día de la semana (0 = lunes … 6 = domingo) de una fecha ISO. */
export function diaSemana(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * @typedef {{ fecha: string, importe_cent: number, pagado?: boolean, proveedor_nombre?: string, numero?: string }} Vto
 * @param {Vto[]} vencimientos  vencimientos de facturas (pagados y pendientes)
 * @param {{ hoy: string, meses?: number }} opts
 */
export function construirCalendario(vencimientos, { hoy, meses = 3 }) {
  const n = MESES_VALIDOS.includes(Number(meses)) ? Number(meses) : 3;
  const mesInicial = claveMes(hoy);
  const mesLimite = sumarMeses(mesInicial, n); // primer mes fuera del rango
  const ordenados = [...vencimientos].sort((a, b) => a.fecha.localeCompare(b.fecha)
    || String(a.proveedor_nombre ?? '').localeCompare(String(b.proveedor_nombre ?? '')));

  // Vencidos: pendientes con fecha anterior a hoy (incluye meses pasados, que no caben en la rejilla).
  const vencidos = ordenados.filter((v) => !v.pagado && v.fecha < hoy);

  const mesesCalendario = [];
  for (let i = 0; i < n; i += 1) {
    const clave = sumarMeses(mesInicial, i);
    const delMes = ordenados.filter((v) => claveMes(v.fecha) === clave);
    mesesCalendario.push({
      mes: clave,
      etiqueta: etiquetaMes(clave),
      semanas: repartirEnSemanas(clave, delMes, hoy),
      items: delMes,
      total_cent: suma(delMes.filter((v) => !v.pagado)),
      pagado_cent: suma(delMes.filter((v) => v.pagado)),
      dias_con_pagos: new Set(delMes.map((v) => v.fecha)).size,
    });
  }

  const pendientesEnRango = mesesCalendario.flatMap((m) => m.items).filter((v) => !v.pagado && v.fecha >= hoy);
  const posteriores = ordenados.filter((v) => !v.pagado && claveMes(v.fecha) >= mesLimite);

  return {
    hoy,
    meses: n,
    desde: `${mesInicial}-01`,
    hasta: `${sumarMeses(mesInicial, n - 1)}-${String(diasDelMes(sumarMeses(mesInicial, n - 1))).padStart(2, '0')}`,
    vencidos: { total_cent: suma(vencidos), items: vencidos },
    calendario: mesesCalendario,
    posteriores: { total_cent: suma(posteriores), items: posteriores },
    // Lo que queda por pagar dentro del periodo mostrado (sin contar lo ya vencido ni lo posterior).
    total_pendiente_cent: suma(pendientesEnRango),
  };
}

/** Rejilla de semanas; cada celda es null (hueco) o { dia, fecha, items, total_cent, esHoy, pasado }. */
function repartirEnSemanas(clave, items, hoy) {
  const total = diasDelMes(clave);
  const primerDia = diaSemana(`${clave}-01`);
  const celdas = Array.from({ length: primerDia }, () => null);
  for (let dia = 1; dia <= total; dia += 1) {
    const fecha = `${clave}-${String(dia).padStart(2, '0')}`;
    const delDia = items.filter((v) => v.fecha === fecha);
    celdas.push({
      dia,
      fecha,
      items: delDia,
      total_cent: suma(delDia.filter((v) => !v.pagado)),
      esHoy: fecha === hoy,
      pasado: fecha < hoy,
    });
  }
  while (celdas.length % 7 !== 0) celdas.push(null);
  const semanas = [];
  for (let i = 0; i < celdas.length; i += 7) semanas.push(celdas.slice(i, i + 7));
  return semanas;
}

function suma(items) {
  return items.reduce((s, v) => s + v.importe_cent, 0);
}
