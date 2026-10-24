// Escritor de PDF mínimo (sin dependencias): páginas A4, texto con las fuentes estándar
// Helvetica/Helvetica-Bold, líneas y rectángulos. Suficiente para informes y tablas.
// El texto se codifica en WinAnsi, que cubre acentos, ñ y €.

export const A4 = { ancho: 595.28, alto: 841.89 };

// Anchos de carácter (milésimas de em) de las fuentes estándar, para medir y recortar texto.
const ANCHOS_NORMAL = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584];
const ANCHOS_NEGRITA = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584];

// Caracteres fuera de Latin-1 que WinAnsi sí tiene (byte distinto al punto de código).
const WINANSI_EXTRA = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89,
  '‹': 0x8b, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9b };

/** Ancho de un texto en puntos para un tamaño de fuente dado. */
export function anchoTexto(texto, tam, negrita = false) {
  const anchos = negrita ? ANCHOS_NEGRITA : ANCHOS_NORMAL;
  let total = 0;
  for (const ch of String(texto)) {
    const code = ch.codePointAt(0);
    // Las vocales acentuadas y la ñ miden como su letra base; el resto, ancho medio.
    const base = code >= 32 && code <= 126 ? anchos[code - 32]
      : 'áàâäãåÁÀÂÄÃÅ'.includes(ch) ? anchos['a'.charCodeAt(0) - 32]
        : 'éèêëÉÈÊË'.includes(ch) ? anchos['e'.charCodeAt(0) - 32]
          : 'íìîïÍÌÎÏ'.includes(ch) ? anchos['i'.charCodeAt(0) - 32]
            : 'óòôöõÓÒÔÖÕ'.includes(ch) ? anchos['o'.charCodeAt(0) - 32]
              : 'úùûüÚÙÛÜ'.includes(ch) ? anchos['u'.charCodeAt(0) - 32]
                : 'ñÑ'.includes(ch) ? anchos['n'.charCodeAt(0) - 32]
                  : 'çÇ'.includes(ch) ? anchos['c'.charCodeAt(0) - 32]
                    : ch === '€' ? 556 : ch === '·' ? 278 : ch === 'º' ? 365 : 556;
    total += base;
  }
  return (total * tam) / 1000;
}

/** Recorta el texto con «…» para que no pase de `max` puntos. */
export function recortar(texto, max, tam, negrita = false) {
  const s = String(texto ?? '');
  if (anchoTexto(s, tam, negrita) <= max) return s;
  let corto = s;
  while (corto.length > 1 && anchoTexto(`${corto}…`, tam, negrita) > max) corto = corto.slice(0, -1);
  return `${corto}…`;
}

function codificar(texto) {
  const bytes = [];
  for (const ch of String(texto)) {
    const code = WINANSI_EXTRA[ch] ?? ch.codePointAt(0);
    bytes.push(code <= 0xff ? code : 0x3f); // '?' para lo que WinAnsi no cubre
  }
  return Buffer.from(bytes).toString('latin1').replace(/[\\()]/g, (c) => `\\${c}`);
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * Documento PDF en construcción. Las coordenadas van en puntos desde la esquina superior
 * izquierda (y hacia abajo), que es más cómodo que el sistema nativo del PDF.
 */
export class DocumentoPdf {
  constructor({ ancho = A4.ancho, alto = A4.alto } = {}) {
    this.ancho = ancho;
    this.alto = alto;
    this.paginas = [];
    this.actual = null;
    this.nuevaPagina();
  }

  nuevaPagina() {
    this.actual = [];
    this.paginas.push(this.actual);
    return this;
  }

  get numPaginas() { return this.paginas.length; }

  /** Ejecuta fn sobre cada página ya creada (para pies de página con la numeración final). */
  enCadaPagina(fn) {
    const previa = this.actual;
    this.paginas.forEach((pagina, i) => {
      this.actual = pagina;
      fn(i + 1, this.paginas.length);
    });
    this.actual = previa;
    return this;
  }

  color(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(fmt).join(' ');
  }

  texto(txt, x, y, { tam = 10, negrita = false, color = '#000000', alinear = 'izquierda', ancho = 0 } = {}) {
    const s = String(txt ?? '');
    if (!s) return this;
    let px = x;
    if (alinear === 'derecha') px = x + ancho - anchoTexto(s, tam, negrita);
    else if (alinear === 'centro') px = x + (ancho - anchoTexto(s, tam, negrita)) / 2;
    this.actual.push(`BT ${this.color(color)} rg /${negrita ? 'FB' : 'FR'} ${fmt(tam)} Tf 1 0 0 1 ${fmt(px)} ${fmt(this.alto - y - tam)} Tm (${codificar(s)}) Tj ET`);
    return this;
  }

  rect(x, y, ancho, alto, { relleno = null, borde = null, grosor = 0.6 } = {}) {
    const y0 = this.alto - y - alto;
    if (relleno) this.actual.push(`${this.color(relleno)} rg ${fmt(x)} ${fmt(y0)} ${fmt(ancho)} ${fmt(alto)} re f`);
    if (borde) this.actual.push(`${this.color(borde)} RG ${fmt(grosor)} w ${fmt(x)} ${fmt(y0)} ${fmt(ancho)} ${fmt(alto)} re S`);
    return this;
  }

  linea(x1, y1, x2, y2, { color = '#000000', grosor = 0.6 } = {}) {
    this.actual.push(`${this.color(color)} RG ${fmt(grosor)} w ${fmt(x1)} ${fmt(this.alto - y1)} m ${fmt(x2)} ${fmt(this.alto - y2)} l S`);
    return this;
  }

  /** Serializa el documento completo. @returns {Buffer} */
  construir() {
    const objetos = [];
    const añadir = (contenido) => { objetos.push(contenido); return objetos.length; };

    const idPaginas = 1;
    objetos.push(''); // reservado para el nodo Pages (se rellena al final)
    const idFuenteR = añadir('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const idFuenteB = añadir('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const idsPagina = [];
    for (const pagina of this.paginas) {
      const flujo = pagina.join('\n');
      const idContenido = añadir(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
      idsPagina.push(añadir(`<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 ${fmt(this.ancho)} ${fmt(this.alto)}] `
        + `/Resources << /Font << /FR ${idFuenteR} 0 R /FB ${idFuenteB} 0 R >> >> /Contents ${idContenido} 0 R >>`));
    }
    objetos[0] = `<< /Type /Pages /Kids [${idsPagina.map((id) => `${id} 0 R`).join(' ')}] /Count ${idsPagina.length} >>`;
    const idCatalogo = añadir(`<< /Type /Catalog /Pages ${idPaginas} 0 R >>`);

    let pdf = '%PDF-1.4\n';
    const posiciones = [];
    objetos.forEach((obj, i) => {
      posiciones.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const inicioXref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const pos of posiciones) pdf += `${String(pos).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root ${idCatalogo} 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }
}
