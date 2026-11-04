// Excel del alta de productos: la plantilla que se descarga y el lector del
// fichero que se sube. Las columnas se reconocen por su título (sin importar
// mayúsculas, tildes ni el orden), así vale también un Excel hecho a mano.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { HttpError } from '../http-error.js';
import { MAX_FILAS_ALTA } from './alta.js';
import { TIPOS } from './tipos.js';

const FILAS_CABECERA = 10; // la cabecera se busca en las primeras filas
const MAX_DESCOMPRIMIDO = 40 * 1024 * 1024; // un .xlsx de 2000 filas ocupa mucho menos
const MAX_CELDA = 250; // ningún dato del alta es más largo

export const COLUMNAS = Object.freeze([
  { campo: 'tipo', titulo: 'Tipo de producto', ancho: 16, alias: ['tipo', 'tipodeproducto', 'tipoproducto', 'categoria'] },
  { campo: 'marca', titulo: 'Fabricante', ancho: 18, alias: ['fabricante', 'marca'] },
  { campo: 'modelo', titulo: 'Modelo', ancho: 22, alias: ['modelo', 'nombre'] },
  { campo: 'referencia', titulo: 'Referencia', ancho: 14, alias: ['referencia', 'ref', 'refer'] },
  { campo: 'talla', titulo: 'Talla', ancho: 8, alias: ['talla', 'numero', 'num'], texto: true },
  { campo: 'color', titulo: 'Color', ancho: 14, alias: ['color', 'colour'] },
  { campo: 'coste', titulo: 'Precio coste', ancho: 12, alias: ['preciocoste', 'preciodecoste', 'coste', 'costeunitario'], euros: true },
  { campo: 'pvp', titulo: 'PVP', ancho: 10, alias: ['pvp', 'precioventa', 'preciodeventa', 'precioventaopvp', 'preciodeventaopvp', 'precioventapvp'], euros: true },
  { campo: 'unidades', titulo: 'Unidades', ancho: 10, alias: ['unidades', 'uds', 'unid', 'cantidad', 'stock'] },
  { campo: 'codigo', titulo: 'Código de barras', ancho: 18, alias: ['codigodebarras', 'codigobarras', 'codigo', 'ean', 'barcode'], texto: true },
  { campo: 'subtipo', titulo: 'Subtipo', ancho: 14, alias: ['subtipo'], opcional: true },
  { campo: 'detalle', titulo: 'Detalle', ancho: 30, alias: ['detalle', 'descripcion', 'notas'], opcional: true },
]);
const OBLIGATORIAS = Object.freeze(['marca', 'referencia', 'unidades']);

const normalTitulo = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** El valor de una celda tal cual (número o texto), mirando dentro de fórmulas, enlaces y texto con formato. */
export function valorCelda(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'object') return typeof v === 'string' ? v.trim().slice(0, MAX_CELDA) : v;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? '').join('').trim().slice(0, MAX_CELDA);
  if (Object.hasOwn(v, 'result')) return valorCelda(v.result);
  if (Object.hasOwn(v, 'text')) return valorCelda(v.text);
  return '';
}

/** Un .xlsx es un ZIP: se mira cuánto ocupa descomprimido antes de abrirlo (un ZIP «bomba» pesa poco y ocupa gigas). */
async function comprobarTamano(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new HttpError(400, 'No se pudo leer el Excel: ¿está dañado o protegido con contraseña?', 'INVALID_XLSX');
  }
  // eslint-disable-next-line no-underscore-dangle
  const total = Object.values(zip.files).reduce((s, f) => s + (f._data?.uncompressedSize ?? 0), 0);
  if (total > MAX_DESCOMPRIMIDO) throw new HttpError(413, 'El Excel es demasiado grande: deja solo la hoja de productos o divídelo.', 'FILE_TOO_LARGE');
}

function buscarCabecera(hoja) {
  for (let r = 1; r <= Math.min(FILAS_CABECERA, hoja.rowCount); r += 1) {
    const mapa = new Map();
    hoja.getRow(r).eachCell((cell, col) => {
      const t = normalTitulo(valorCelda(cell.value));
      const c = COLUMNAS.find((x) => x.alias.includes(t));
      if (c && ![...mapa.values()].includes(c.campo)) mapa.set(col, c.campo);
    });
    if (OBLIGATORIAS.every((k) => [...mapa.values()].includes(k))) return { fila: r, mapa };
  }
  return null;
}

/**
 * Lee las filas de producto de un .xlsx. Cada fila lleva su número en el Excel
 * (`fila`) para que los errores digan dónde mirar. Las filas vacías se saltan.
 * @returns {Promise<object[]>}
 */
export async function leerExcelAlta(buffer) {
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new HttpError(400, 'El archivo no es un Excel .xlsx. Si es un .xls antiguo o un .csv, ábrelo y guárdalo como «Libro de Excel (.xlsx)».', 'NOT_XLSX');
  }
  await comprobarTamano(buffer);
  const libro = new ExcelJS.Workbook();
  try {
    await libro.xlsx.load(buffer);
  } catch {
    throw new HttpError(400, 'No se pudo leer el Excel: ¿está dañado o protegido con contraseña?', 'INVALID_XLSX');
  }
  const hoja = libro.worksheets.map((h) => ({ h, cab: buscarCabecera(h) })).find((x) => x.cab);
  if (!hoja) {
    throw new HttpError(400, `No encuentro la fila de títulos: el Excel necesita al menos las columnas ${OBLIGATORIAS.map((k) => `«${COLUMNAS.find((c) => c.campo === k).titulo}»`).join(', ')}. Descarga la plantilla para verlo.`, 'NO_HEADER');
  }
  const { h, cab } = hoja;
  const filas = [];
  // eachRow recorre solo las filas que existen (no el millón de una hoja con una celda al final).
  h.eachRow((row, r) => {
    if (r <= cab.fila || filas.length > MAX_FILAS_ALTA) return;
    const fila = { fila: r };
    for (const [col, campo] of cab.mapa) fila[campo] = valorCelda(row.getCell(col).value);
    if (![...cab.mapa.values()].every((campo) => fila[campo] === '')) filas.push(fila);
  });
  if (filas.length > MAX_FILAS_ALTA) throw new HttpError(400, `El Excel tiene más de ${MAX_FILAS_ALTA} productos: divídelo en varios.`, 'TOO_MANY_ROWS');
  if (!filas.length) throw new HttpError(400, 'El Excel no tiene productos debajo de los títulos.', 'NO_ROWS');
  return filas;
}

const EJEMPLOS = Object.freeze([
  ['Calzado', 'Pablosky', 'Bota cremallera', '504555', '27', 'Marino', '22,50', '45,95', '2', '', 'Botas', 'Piel, forro de lana'],
  ['Calzado', 'Pablosky', 'Bota cremallera', '504555', '28', 'Marino', '22,50', '45,95', '1', '2004567890126', 'Botas', 'Piel, forro de lana'],
  ['Ropa', 'Fabricante', 'Pijama manga larga', 'PJ-200', '4A', 'Gris', '9', '19,95', '3', '8412345678905', 'Pijamas', ''],
  ['Juguetes', 'Fabricante', 'Yoyó de madera', 'YY-01', '', '', '2,10', '5,50', '10', '', 'Yoyós', ''],
]);

/** Plantilla .xlsx: hoja «Productos» vacía con sus títulos y hoja «Instrucciones» con ejemplos. */
export async function plantillaAlta(subtipos = []) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Puntapié · Gestión';
  libro.created = new Date();
  const hoja = libro.addWorksheet('Productos', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.campo, width: c.ancho, style: c.texto ? { numFmt: '@' } : c.euros ? { numFmt: '#,##0.00' } : {} }));
  const cabecera = hoja.getRow(1);
  cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D50' } };
  const tipos = Object.values(TIPOS).map((t) => t.nombre).join(',');
  const colTipo = COLUMNAS.findIndex((c) => c.campo === 'tipo') + 1;
  for (let r = 2; r <= MAX_FILAS_ALTA + 1; r += 1) {
    hoja.getCell(r, colTipo).dataValidation = {
      type: 'list', allowBlank: true, formulae: [`"${tipos}"`], showErrorMessage: true, errorTitle: 'Tipo de producto', error: `Elige: ${tipos.replace(/,/g, ', ')}`,
    };
  }
  const ayuda = libro.addWorksheet('Instrucciones');
  ayuda.columns = COLUMNAS.map((c) => ({ header: c.titulo, width: c.ancho }));
  ayuda.getRow(1).font = { bold: true };
  EJEMPLOS.forEach((fila) => ayuda.addRow(fila));
  const notas = [
    '',
    'Copia tus productos en la hoja «Productos» (una fila por talla y color) y súbela en Stock › Inventario › Importar Excel.',
    'Obligatorios: Fabricante, Referencia, Unidades y la Talla (vacía = talla única, para juguetes y accesorios). El Color, salvo en juguetes.',
    'Tipo de producto: Calzado, Ropa, Accesorios o Juguetes. Si se deja vacío: con talla de pie es calzado; si no, accesorio.',
    'Modelo: si se deja vacío se usa la referencia.',
    'Precios en euros (22,50). Unidades: cuántas hay en la tienda (0 = dar de alta sin stock).',
    'Código de barras: vacío = se genera uno nuevo (200…). Un 200… de las etiquetas antiguas se conserva. Otro (el de la caja) se guarda como código de fábrica y se genera uno nuevo para la etiqueta.',
    'Si un producto (fabricante + modelo + referencia + color + talla) ya existe con los mismos datos, sus unidades se suman. Si algún dato es distinto, se te pregunta antes de importar.',
    subtipos.length ? `Subtipos (opcional): ${subtipos.map((s) => `${TIPOS[s.type]?.nombre ?? s.type}: ${s.name}`).join(' · ')}.` : '',
  ];
  notas.forEach((t) => ayuda.addRow([t]));
  return Buffer.from(await libro.xlsx.writeBuffer());
}
