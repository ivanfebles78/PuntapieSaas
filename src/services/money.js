import { HttpError } from '../http-error.js';

const MAX_CENTS = 100_000_000; // 1.000.000,00 €
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Convierte un importe en euros a céntimos. Acepta número o texto con coma
 * o punto decimal y separador de miles («1.234,56», «1234.5», «1 234»).
 */
export function readCents(value, label = 'El importe') {
  let text = typeof value === 'number' ? String(value) : String(value ?? '').trim().replace(/\s|€/g, '');
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new HttpError(400, `${label} no es válido: usa un número como 1250,50.`, 'INVALID_AMOUNT');
  }
  const cents = Math.round(Number(text) * 100);
  if (cents > MAX_CENTS) throw new HttpError(400, `${label} es demasiado alto.`, 'INVALID_AMOUNT');
  return cents;
}

/** «2026-10» → «2026-10-01» (fecha del primer día, como se guarda el mes). */
export function readMonth(value, label = 'El mes') {
  const text = String(value ?? '');
  if (!MONTH_PATTERN.test(text)) throw new HttpError(400, `${label} no es válido (formato AAAA-MM).`, 'INVALID_MONTH');
  return `${text}-01`;
}

/** «2026-10-23» validada (fecha real del calendario). */
export function readDay(value, label = 'La fecha') {
  const text = String(value ?? '');
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, `${label} no es válida.`, 'INVALID_DATE');
  }
  return text;
}

/** Meses (primer día) entre dos meses, ambos incluidos. */
export function monthsBetween(fromFirstDay, toFirstDay) {
  const months = [];
  const [year, month] = fromFirstDay.split('-').map(Number);
  for (let i = 0; ; i += 1) {
    const current = new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 10);
    if (current > toFirstDay) return months;
    months.push(current);
  }
}

export function previousMonth(firstDay) {
  const [year, month] = firstDay.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 10);
}

const EUROS = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', useGrouping: 'always' });

/** 125050 → «1.250,50 €» (para el log y las exportaciones). */
export function formatEuros(cents) {
  return cents === null || cents === undefined ? null : EUROS.format(cents / 100);
}
