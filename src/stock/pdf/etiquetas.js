// Etiquetas de 50 × 25 mm para impresora de rollo: una etiqueta por página,
// con marca, referencia, modelo, color, talla, PVP y el código EAN-13.
import { DocumentoPdf, recortar } from '../../proveedores/pdf/documento.js';
import { esEan13 } from '../barcode.js';

const MM = 72 / 25.4;
export const ETIQUETA = Object.freeze({ ancho: 50 * MM, alto: 25 * MM });

const MARGEN = 5;
const MODULO = 1; // ancho de la barra más fina, en puntos (≈ 0,35 mm)
const ALTO_BARRAS = 30;
const EXTRA_GUARDAS = 4;
const Y_BARRAS = 24;

// Codificación EAN-13 (GS1): juegos L, G y R, y paridad según el primer dígito.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARIDAD = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Los 95 módulos (1 = barra) de un EAN-13. */
export function modulosEan13(code) {
  if (!esEan13(code)) throw new Error(`Código EAN-13 no válido: ${code}`);
  const d = [...code].map(Number);
  const izquierda = d.slice(1, 7).map((n, i) => (PARIDAD[d[0]][i] === 'L' ? L : G)[n]).join('');
  const derecha = d.slice(7).map((n) => R[n]).join('');
  return `101${izquierda}01010${derecha}101`;
}

// Las guardas (inicio, centro y fin) bajan un poco más que el resto.
const esGuarda = (i) => i < 3 || (i >= 45 && i < 50) || i >= 92;

function dibujarCodigo(pdf, code, x, y) {
  const modulos = modulosEan13(code);
  let i = 0;
  while (i < modulos.length) {
    if (modulos[i] !== '1') { i += 1; continue; }
    let fin = i;
    while (fin < modulos.length && modulos[fin] === '1' && esGuarda(fin) === esGuarda(i)) fin += 1;
    pdf.rect(x + i * MODULO, y, (fin - i) * MODULO, ALTO_BARRAS + (esGuarda(i) ? EXTRA_GUARDAS : 0), { relleno: '#000000' });
    i = fin;
  }
  // Dígitos legibles: el primero fuera, a la izquierda; luego 6 y 6 bajo cada mitad.
  const yTexto = y + ALTO_BARRAS + 0.5;
  const tam = 6.5;
  pdf.texto(code[0], x - 6, yTexto, { tam });
  pdf.texto(code.slice(1, 7), x + 3 * MODULO, yTexto, { tam, alinear: 'centro', ancho: 42 * MODULO });
  pdf.texto(code.slice(7), x + 50 * MODULO, yTexto, { tam, alinear: 'centro', ancho: 42 * MODULO });
}

const euros = (cent) => `${(cent / 100).toFixed(2).replace('.', ',')} €`;

/**
 * @param {{ marca: string, modelo: string, referencia: string, color: string, talla: number, codigo: string, pvp_cent: number|null }[]} etiquetas
 * @returns {Buffer}
 */
export function generarEtiquetasPdf(etiquetas) {
  const pdf = new DocumentoPdf({ ancho: ETIQUETA.ancho, alto: ETIQUETA.alto });
  const util = ETIQUETA.ancho - 2 * MARGEN;
  etiquetas.forEach((e, n) => {
    if (n > 0) pdf.nuevaPagina();
    const talla = e.talla ? `T. ${e.talla}` : '';
    const precio = e.pvp_cent != null ? euros(e.pvp_cent) : '';
    pdf.texto(talla, MARGEN, 3.5, { tam: 9.5, negrita: true, alinear: 'derecha', ancho: util });
    pdf.texto(recortar(`${e.marca} · ${e.referencia}`, util - 34, 7.5, true), MARGEN, 4, { tam: 7.5, negrita: true });
    pdf.texto(precio, MARGEN, 14, { tam: 8, negrita: true, alinear: 'derecha', ancho: util });
    const detalle = e.modelo && e.modelo !== e.referencia ? `${e.modelo} · ${e.color}` : e.color;
    pdf.texto(recortar(detalle, util - 36, 6.5), MARGEN, 14.5, { tam: 6.5 });
    const anchoCodigo = 95 * MODULO;
    if (esEan13(e.codigo)) dibujarCodigo(pdf, e.codigo, (ETIQUETA.ancho - anchoCodigo) / 2 + 3, Y_BARRAS);
    else pdf.texto(e.codigo, MARGEN, Y_BARRAS + 10, { tam: 9, alinear: 'centro', ancho: util });
  });
  return pdf.construir();
}
