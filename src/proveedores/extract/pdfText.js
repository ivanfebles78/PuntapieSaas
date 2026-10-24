// Extrae el texto de un PDF reconstruyendo las líneas por posición.
// pdf.js devuelve los fragmentos en orden de dibujado (no de lectura), así que
// agrupamos por coordenada Y y ordenamos por X. Esto da líneas legibles del tipo
// "Fecha Vto. e importe: 25/12/25 577,60 EUR" con las que los parsers trabajan.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const Y_TOLERANCE = 3;

/**
 * @typedef {{ y: number, items: { x: number, s: string }[], text: string }} Line
 * @typedef {{ pages: Line[][], lines: Line[], text: string }} PdfText
 */

/**
 * @param {Uint8Array|Buffer} bytes
 * @returns {Promise<PdfText>}
 */
export async function extractPdfText(bytes) {
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const task = getDocument({ data, useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(groupIntoLines(content.items));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  const lines = pages.flat();
  return { pages, lines, text: lines.map((l) => l.text).join('\n') };
}

/** @param {any[]} items */
function groupIntoLines(items) {
  /** @type {Map<number, {x:number,s:string}[]>} */
  const rows = new Map();
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const y = it.transform[5];
    let key;
    for (const k of rows.keys()) {
      if (Math.abs(k - y) <= Y_TOLERANCE) { key = k; break; }
    }
    if (key === undefined) { key = y; rows.set(key, []); }
    rows.get(key).push({ x: it.transform[4], s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, its]) => {
      const sorted = [...its].sort((a, b) => a.x - b.x);
      return { y, items: sorted, text: sorted.map((i) => i.s.trim()).join(' ').replace(/\s+/g, ' ') };
    });
}
