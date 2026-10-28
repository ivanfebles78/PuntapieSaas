// Códigos de barras del inventario: EAN-13 con el mismo formato que la web
// antigua (pp_generate_barcode): prefijo 200 (uso interno en tienda, GS1),
// 9 dígitos aleatorios y el dígito de control.
import crypto from 'node:crypto';

const PREFIJO = '200';
const DIGITOS_ALEATORIOS = 9;

/** Dígito de control GS1 de 12 dígitos: posiciones impares ×1, pares ×3. */
export function digitoControl(code12) {
  if (!/^\d{12}$/.test(code12)) throw new Error('Se requieren exactamente 12 dígitos');
  let suma = 0;
  for (let i = 0; i < 12; i += 1) suma += Number(code12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (suma % 10)) % 10;
}

export const esEan13 = (code) => /^\d{13}$/.test(String(code)) && Number(code[12]) === digitoControl(code.slice(0, 12));

/** Un EAN-13 nuevo «200» + 9 aleatorios + control (la unicidad la garantiza la BD). */
export function nuevoCodigo() {
  const aleatorio = String(crypto.randomInt(0, 10 ** DIGITOS_ALEATORIOS)).padStart(DIGITOS_ALEATORIOS, '0');
  const code12 = `${PREFIJO}${aleatorio}`;
  return `${code12}${digitoControl(code12)}`;
}
