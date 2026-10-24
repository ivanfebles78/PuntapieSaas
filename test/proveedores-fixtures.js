import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../src/proveedores/extract/pdfText.js';

// Facturas reales de proveedores: NO están en el repositorio (es público). Los
// tests que las usan se saltan si falta la carpeta test/fixtures-proveedores.
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-proveedores');
export const HAY_FIXTURES = fs.existsSync(path.join(FIXTURES, 'lejan'));
export const SIN_FIXTURES = { skip: HAY_FIXTURES ? false : 'sin PDFs reales en test/fixtures-proveedores' };

const cache = new Map();

/** Lee y cachea el texto de un PDF de fixtures (ruta relativa a la carpeta). */
export async function fixtureText(rel) {
  if (!cache.has(rel)) {
    const bytes = fs.readFileSync(path.join(FIXTURES, rel));
    cache.set(rel, await extractPdfText(bytes));
  }
  return cache.get(rel);
}

export function fixtureBytes(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel));
}
