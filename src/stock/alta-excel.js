// Excel del alta de productos: la plantilla que se descarga y el lector del
// fichero que se sube. Las columnas se reconocen por su título (sin importar
// mayúsculas, tildes ni el orden), así vale también un Excel hecho a mano.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { HttpError } from '../http-error.js';
import { MAX_FILAS_ALTA } from './alta.js';

const FILAS_CABECERA = 10; // la cabecera se busca en las primeras filas
const MAX_DESCOMPRIMIDO = 40 * 1024 * 1024; // un .xlsx de 2000 filas ocupa mucho menos
const MAX_CELDA = 250; // ningún dato del alta es más largo

export const COLUMNAS = Object.freeze([
  { campo: 'tipo', titulo: 'Tipo de producto', ancho: 16, alias: ['tipo', 'tipodeproducto', 'tipoproducto', 'categoria'] },
  { campo: 'subtipo', titulo: 'Subtipo', ancho: 14, alias: ['subtipo'], opcional: true },
  { campo: 'marca', titulo: 'Fabricante', ancho: 18, alias: ['fabricante', 'marca'] },
  { campo: 'modelo', titulo: 'Modelo', ancho: 22, alias: ['modelo', 'nombre'] },
  { campo: 'referencia', titulo: 'Referencia', ancho: 14, alias: ['referencia', 'ref', 'refer'] },
  { campo: 'talla', titulo: 'Talla', ancho: 8, alias: ['talla', 'numero', 'num'], texto: true },
  { campo: 'color', titulo: 'Color', ancho: 14, alias: ['color', 'colour'] },
  { campo: 'coste', titulo: 'Precio coste', ancho: 12, alias: ['preciocoste', 'preciodecoste', 'coste', 'costeunitario'], euros: true },
  { campo: 'pvp', titulo: 'PVP', ancho: 10, alias: ['pvp', 'precioventa', 'preciodeventa', 'precioventaopvp', 'preciodeventaopvp', 'precioventapvp'], euros: true },
  { campo: 'unidades', titulo: 'Unidades', ancho: 10, alias: ['unidades', 'uds', 'unid', 'cantidad', 'stock'] },
  { campo: 'codigo', titulo: 'Código de barras', ancho: 18, alias: ['codigodebarras', 'codigobarras', 'codigo', 'ean', 'barcode'], texto: true },
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

// Ejemplos por campo (el orden de las columnas lo pone COLUMNAS).
const EJEMPLOS = Object.freeze([
  { tipo: 'Calzado', subtipo: 'Botas', marca: 'Pablosky', modelo: 'Bota cremallera', referencia: '504555', talla: '27', color: 'Marino', coste: '22,50', pvp: '45,95', unidades: '2', codigo: '', detalle: 'Piel, forro de lana' },
  { tipo: 'Calzado', subtipo: 'Botas', marca: 'Pablosky', modelo: 'Bota cremallera', referencia: '504555', talla: '28', color: 'Marino', coste: '22,50', pvp: '45,95', unidades: '1', codigo: '2004567890126', detalle: 'Piel, forro de lana' },
  { tipo: 'Ropa', subtipo: 'Pijamas', marca: 'Fabricante', modelo: 'Pijama manga larga', referencia: 'PJ-200', talla: '4A', color: 'Gris', coste: '9', pvp: '19,95', unidades: '3', codigo: '8412345678905', detalle: '' },
  { tipo: 'Juguetes', subtipo: 'Yoyós', marca: 'Fabricante', modelo: 'Yoyó de madera', referencia: 'YY-01', talla: '', color: '', coste: '2,10', pvp: '5,50', unidades: '10', codigo: '', detalle: '' },
]);

const HOJA_LISTAS = 'Listas';
// Columnas de «Listas» que alimentan los desplegables de «Productos».
const LISTA = Object.freeze({ tipos: 'A', subtipos: 'B', marcas: 'C' });

/** Desplegable de una columna de «Productos» con los valores de una columna de «Listas». */
function desplegable(hoja, campo, letra, n, estricto) {
  if (!n) return;
  const c = COLUMNAS.findIndex((x) => x.campo === campo) + 1;
  const titulo = COLUMNAS[c - 1].titulo;
  for (let r = 2; r <= MAX_FILAS_ALTA + 1; r += 1) {
    hoja.getCell(r, c).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`'${HOJA_LISTAS}'!$${letra}$2:$${letra}$${n + 1}`],
      // El fabricante no es estricto: se puede escribir uno nuevo (entra solo en el catálogo).
      showErrorMessage: estricto,
      errorStyle: 'stop',
      errorTitle: titulo,
      error: `Elige un valor de la lista (hoja «${HOJA_LISTAS}»).`,
    };
  }
}

/**
 * Hoja «Listas»: los tipos, subtipos y fabricantes (columnas A-C, para los
 * desplegables) y, después, los subtipos y fabricantes de cada tipo, para consultar.
 */
function hojaListas(libro, catalogo) {
  const hoja = libro.addWorksheet(HOJA_LISTAS);
  const { tipos } = catalogo;
  const subtipos = [...new Set(tipos.flatMap((t) => t.subtipos.map((s) => s.nombre)))].sort((a, b) => a.localeCompare(b, 'es'));
  const marcas = catalogo.marcas.map((m) => m.nombre);
  const marcasDe = (t) => catalogo.marcas
    .filter((m) => !m.ambitos.length || m.ambitos.some((a) => a.tipo === t.id))
    .map((m) => {
      const sub = m.ambitos.filter((a) => a.tipo === t.id && a.subtipo_id)
        .map((a) => t.subtipos.find((s) => s.id === a.subtipo_id)?.nombre).filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
      return sub.length ? `${m.nombre} (${sub.join(', ')})` : m.nombre;
    });
  const columnas = [
    ['Tipos', tipos.map((t) => t.nombre)],
    ['Subtipos', subtipos],
    ['Fabricantes', marcas],
    ...tipos.flatMap((t) => [[`Subtipos de ${t.nombre}`, t.subtipos.map((s) => s.nombre)], [`Fabricantes de ${t.nombre}`, marcasDe(t)]]),
  ];
  columnas.forEach(([titulo, valores], i) => {
    hoja.getColumn(i + 1).width = Math.min(40, Math.max(14, titulo.length + 2, ...valores.map((v) => v.length + 2)));
    hoja.getCell(1, i + 1).value = titulo;
    valores.forEach((v, j) => { hoja.getCell(j + 2, i + 1).value = v; });
  });
  hoja.getRow(1).font = { bold: true };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  return { tipos: tipos.length, subtipos: subtipos.length, marcas: marcas.length };
}

const listaConO = (nombres) => (nombres.length > 1 ? `${nombres.slice(0, -1).join(', ')} o ${nombres.at(-1)}` : nombres.join(''));

/**
 * Plantilla .xlsx: hoja «Productos» vacía con sus títulos y desplegables,
 * «Instrucciones» con ejemplos y «Listas» con el catálogo.
 * @param {{ tipos: object[], marcas: object[] }} catalogo  como lo da leerCatalogo
 */
export async function plantillaAlta(catalogo = { tipos: [], marcas: [] }) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Puntapié · Gestión';
  libro.created = new Date();
  const hoja = libro.addWorksheet('Productos', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.campo, width: c.ancho, style: c.texto ? { numFmt: '@' } : c.euros ? { numFmt: '#,##0.00' } : {} }));
  const cabecera = hoja.getRow(1);
  cabecera.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecera.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D50' } };

  const ayuda = libro.addWorksheet('Instrucciones');
  const n = hojaListas(libro, catalogo);
  desplegable(hoja, 'tipo', LISTA.tipos, n.tipos, true);
  desplegable(hoja, 'subtipo', LISTA.subtipos, n.subtipos, true);
  desplegable(hoja, 'marca', LISTA.marcas, n.marcas, false);

  ayuda.columns = COLUMNAS.map((c) => ({ header: c.titulo, width: c.ancho }));
  ayuda.getRow(1).font = { bold: true };
  EJEMPLOS.forEach((e) => ayuda.addRow(COLUMNAS.map((c) => e[c.campo] ?? '')));
  const tipos = listaConO(catalogo.tipos.map((t) => t.nombre));
  const notas = [
    '',
    'Copia tus productos en la hoja «Productos» (una fila por talla y color) y súbela en Stock › Inventario › Importar Excel.',
    'Obligatorios: Fabricante, Referencia, Unidades y la Talla (vacía = talla única, para juguetes y accesorios). El Color, salvo en los tipos que no lo piden.',
    `Tipo de producto: ${tipos || `uno de la hoja «${HOJA_LISTAS}»`}. Si se deja vacío: con talla de pie es calzado; si no, accesorio.`,
    `Subtipo (opcional): uno del tipo de esa fila. En la hoja «${HOJA_LISTAS}» están los subtipos y los fabricantes de cada tipo.`,
    'Fabricante: elígelo de la lista o escribe uno nuevo (se añade solo a Admin › Catálogo).',
    'Modelo: si se deja vacío se usa la referencia.',
    'Precios en euros (22,50). Unidades: cuántas hay en la tienda (0 = dar de alta sin stock).',
    'Código de barras: vacío = se genera uno nuevo (200…). Un 200… de las etiquetas antiguas se conserva. Otro (el de la caja) se guarda como código de fábrica y se genera uno nuevo para la etiqueta.',
    'Si un producto (fabricante + modelo + referencia + color + talla) ya existe con los mismos datos, sus unidades se suman. Si algún dato es distinto, se te pregunta antes de importar.',
  ];
  notas.forEach((t) => ayuda.addRow([t]));
  return Buffer.from(await libro.xlsx.writeBuffer());
}
