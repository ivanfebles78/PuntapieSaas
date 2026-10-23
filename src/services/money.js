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

export function previousMonth(firstDay) {
  const [year, month] = firstDay.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 10);
}
