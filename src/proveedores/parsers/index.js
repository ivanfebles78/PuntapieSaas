// Registro de parsers. Cada parser expone { id, nombre, detect(text), parse(pdfText, ctx) }.
// detect() decide si el documento es suyo (normalmente por el CIF del proveedor);
// si ninguno lo reconoce se usa el genérico, que trabaja por heurísticas.
import { garvalin } from './garvalin.js';
import { lejan } from './lejan.js';
import { pablosky } from './pablosky.js';
import { titanitos } from './titanitos.js';
import { gioseppo } from './gioseppo.js';
import { condor } from './condor.js';
import { etika } from './etika.js';
import { victoria } from './victoria.js';
import { vulladi } from './vulladi.js';
import { generico } from './generico.js';
import { lineasDe } from './lineas.js';

export const PARSERS = [garvalin, lejan, pablosky, titanitos, gioseppo, condor, etika, victoria, vulladi];

/**
 * @typedef {Object} Extraido
 * @property {'factura'|'pedido'} tipo
 * @property {{ nombre: string|null, cif: string|null }} proveedor
 * @property {string|null} numero
 * @property {string|null} fecha ISO YYYY-MM-DD
 * @property {number|null} total_cent
 * @property {{ fecha: string, importe_cent: number }[]} vencimientos
 * @property {string[]} pedidos
 * @property {string[]} albaranes
 * @property {string|null} fecha_entrega
 * @property {string|null} forma_pago
 * @property {string} parser
 * @property {'alta'|'media'|'baja'} confianza
 * @property {Linea[]} lineas productos (una por talla) que llegarán con el documento
 * @property {string[]} avisos
 */

/**
 * @typedef {{ marca: string, referencia: string, modelo: string, color: string, talla: number, cantidad: number, coste_cent: number|null, pvp_cent: number|null }} Linea
 */

export function detectParser(text) {
  return PARSERS.find((p) => p.detect(text)) ?? generico;
}

/**
 * @param {{ lines: {text:string}[], pages: any[], text: string }} pdfText
 * @param {{ cifsPropios?: string[] }} [ctx]
 * @returns {Extraido}
 */
export function parseDocumento(pdfText, ctx = {}) {
  const parser = detectParser(pdfText.text);
  const base = vacio(parser.id);
  const leido = parser.parse(pdfText, ctx);
  // Si el lector del proveedor no saca los productos, se buscan con el lector de líneas.
  const lineas = leido.lineas?.length ? leido.lineas : lineasDe(parser.id, pdfText);
  return validar({ ...base, ...leido, lineas });
}

export function vacio(parserId) {
  return {
    tipo: 'factura',
    proveedor: { nombre: null, cif: null },
    numero: null,
    fecha: null,
    total_cent: null,
    vencimientos: [],
    pedidos: [],
    albaranes: [],
    fecha_entrega: null,
    forma_pago: null,
    lineas: [],
    parser: parserId,
    confianza: 'alta',
    avisos: [],
  };
}

/** Comprobaciones comunes: rebajan la confianza y añaden avisos, nunca lanzan. */
function validar(d) {
  const avisos = [...d.avisos];
  if (!d.numero) avisos.push('No se ha encontrado el número de documento.');
  if (!d.fecha) avisos.push('No se ha encontrado la fecha del documento.');
  if (d.total_cent == null) avisos.push('No se ha encontrado el importe total.');
  if (!d.proveedor.cif && !d.proveedor.nombre) avisos.push('No se ha identificado al proveedor.');

  if (d.tipo === 'factura') {
    if (d.vencimientos.length === 0) {
      avisos.push('No se han encontrado vencimientos; se asumirá un único pago en la fecha de la factura.');
    } else if (d.total_cent != null) {
      const suma = d.vencimientos.reduce((s, v) => s + v.importe_cent, 0);
      if (Math.abs(suma - d.total_cent) > 1) {
        avisos.push(`La suma de vencimientos (${(suma / 100).toFixed(2)}) no coincide con el total (${(d.total_cent / 100).toFixed(2)}).`);
      }
    }
  }

  let confianza = d.confianza;
  if (avisos.length > 0 && confianza === 'alta') confianza = 'media';
  if (avisos.length >= 3 || d.parser === 'generico') confianza = 'baja';
  return { ...d, avisos, confianza };
}
