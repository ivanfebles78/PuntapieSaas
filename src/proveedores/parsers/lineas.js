// Productos de los documentos cuyos lectores no los sacan por sí mismos
// (Gioseppo, Lejan y la propuesta de Pablosky ya los devuelven en `lineas`).
//
// Hay dos tipos de documento:
//  - Talla a talla (Condor, pedidos de Etika y Victoria): cada talla con sus unidades.
//  - Por tramos (facturas de Garvalín, Titanitos y Pablosky): «18-25 · 8 pares»
//    sin decir cuántos de cada talla. Se devuelve una fila por talla con
//    cantidad 0 y el `tramo` al que pertenece, para repartirlo a mano.
import { colorSimple } from './pablosky.js';
import { parseImporteEs, titulo } from './utils.js';

/**
 * Filas de un tramo de tallas sin desglose: una por talla, a repartir.
 * Si el tramo es de una sola talla, ya va con su cantidad.
 */
export function filasDeTramo(base, { desde, hasta, total, id }) {
  if (desde === hasta) return [{ ...base, talla: desde, cantidad: total }];
  const filas = [];
  for (let talla = desde; talla <= hasta; talla += 1) {
    filas.push({ ...base, talla, cantidad: 0, tramo: { id, desde, hasta, total } });
  }
  return filas;
}

const textos = (lines) => lines.map((l) => l.text);

/* ---------- Garvalín (factura): «261105-C677 BOTIN CASUAL LATTE MACCHIATO (SERRAJE) 18-25 8 24,50 0,00 196,00» ---------- */

const RE_GARVALIN = /^(\d{5,7})-(\S+)\s+(.+?)\s+(\d{2})-(\d{2})\s+(\d+)\s+(\d+,\d{2})\s+\d+,\d{2}\s+[\d.]+,\d{2}$/;

function garvalin(lines) {
  return textos(lines).flatMap((t, i) => {
    const m = t.match(RE_GARVALIN);
    if (!m) return [];
    const [, ref, , descripcion, desde, hasta, total, precio] = m;
    const palabras = descripcion.replace(/\([^)]*\)/g, '').trim().split(/\s+/);
    const color = titulo(palabras.pop());
    const base = { marca: 'Garvalín', referencia: ref, modelo: titulo(palabras.join(' ')) || ref, color, coste_cent: parseImporteEs(precio), pvp_cent: null };
    return filasDeTramo(base, { desde: Number(desde), hasta: Number(hasta), total: Number(total), id: `g${i}` });
  });
}

/* ---------- Titanitos (factura): «U540 CARLET CALZADO ... CASTAÑA Serie 0101 20-27 8 27,5000 EUR 220,00 EUR» ---------- */

const RE_TITANITOS = /^(\S+)\s+(\S+)\s+(.+?)\s+serie\s+\d+\s+(\d{2})-(\d{2})\s+(\d+)\s+(\d+,\d{2,4})\s+EUR\s+[\d.]+,\d{2}\s+EUR$/i;
// El color va al final de la descripción, y a veces sigue en la línea siguiente («BLANCO» + «ROSA BB»).
const COLORES = new Set(['BLANCO', 'NEGRO', 'MARINO', 'AZUL', 'ROJO', 'ROSA', 'CELESTE', 'MOSTAZA', 'CASTAÑA', 'CASTAÑO', 'MARRON', 'MARRÓN',
  'GRIS', 'VERDE', 'BEIGE', 'CAMEL', 'CUERO', 'TAUPE', 'KAKI', 'CAQUI', 'BURDEOS', 'NARANJA', 'AMARILLO', 'LILA', 'MALVA', 'PLATA', 'ORO',
  'COMBINADO', 'MULTICOLOR', 'NUDE', 'PIEDRA', 'ARENA', 'BB', 'TOPO', 'NAVY', 'BABY', 'PLOMO', 'VAINILLA', 'CHOCOLATE', 'FUCSIA',
  'TURQUESA', 'MENTA', 'CORAL', 'BOTELLA', 'KHAKI', 'DENIM', 'JEANS', 'BRONCE', 'METALIZADO', 'CHAMPAGNE', 'LAVANDA', 'MOKA', 'CREMA']);
// «COMBINADO 1»: un número detrás de un color es parte del color.
const esColor = (palabras, i) => COLORES.has(palabras[i]?.toUpperCase()) || (/^\d$/.test(palabras[i] ?? '') && COLORES.has(palabras[i - 1]?.toUpperCase()));
const RE_CONTINUACION = /^[A-ZÁÉÍÓÚÑ0-9 ]{1,20}$/;

function titanitos(lines) {
  const ts = textos(lines);
  return ts.flatMap((t, i) => {
    const m = t.match(RE_TITANITOS);
    if (!m) return [];
    const [, codigo, nombre, descripcion, desde, hasta, total, precio] = m;
    const palabras = descripcion.split(/\s+/);
    const color = [];
    while (palabras.length > 1 && esColor(palabras, palabras.length - 1)) color.unshift(palabras.pop());
    const siguiente = ts[i + 1] ?? '';
    if (RE_CONTINUACION.test(siguiente) && !RE_TITANITOS.test(siguiente) && !/^N[ºo°]/.test(siguiente)) color.push(siguiente);
    const base = {
      marca: 'Titanitos', referencia: codigo, modelo: titulo(nombre), color: titulo(color.join(' ')) || 'Único',
      coste_cent: parseImporteEs(precio.replace(/(,\d{2})\d+$/, '$1')), pvp_cent: null,
    };
    return filasDeTramo(base, { desde: Number(desde), hasta: Number(hasta), total: Number(total), id: `t${i}` });
  });
}

/* ---------- Pablosky (factura/proforma): «4 18-23 060330 PLUS AVORIO 26,83 107,32»; la siguiente fila sin modelo es otro tramo ---------- */

const RE_PABLOSKY = /^(\d+)\s+(\d{2})-(\d{2})\s+(?:(\d{6})\s+(.+?)\s+)?(\d+,\d{2})\s+[\d.]+,\d{2}$/;

function pablosky(lines) {
  let ref = null;
  let descripcion = '';
  return textos(lines).flatMap((t, i) => {
    const m = t.match(RE_PABLOSKY);
    if (!m) return [];
    const [, total, desde, hasta, nuevaRef, nuevaDesc, precio] = m;
    if (nuevaRef) { ref = nuevaRef; descripcion = nuevaDesc; }
    if (!ref) return [];
    const palabras = descripcion.split(/\s+/);
    const modelo = palabras.length > 1 ? titulo(palabras[0]) : ref;
    const color = palabras.length > 1 ? titulo(palabras.slice(1).join(' ')) : colorSimple(descripcion);
    const base = { marca: 'Pablosky', referencia: ref, modelo, color, coste_cent: parseImporteEs(precio), pvp_cent: null };
    return filasDeTramo(base, { desde: Number(desde), hasta: Number(hasta), total: Number(total), id: `p${i}` });
  });
}

/* ---------- Condor (factura): «2.016/2 Calcetines altos básicos canalé 4 6 3,78 € 22,68 €», y debajo las demás tallas ---------- */

const RE_CONDOR = /^(\d[\d.]*\/\d+)\s+(.+?)\s+(\d{1,2})\s+(\d+)\s+(\d+,\d{2}) €\s+[\d.]+,\d{2} €$/;
const RE_CONDOR_TALLA = /^(\d{1,2})\s+(\d+)\s+(\d+,\d{2}) €\s+[\d.]+,\d{2} €$/;

function condor(lines) {
  let actual = null;
  return textos(lines).flatMap((t) => {
    const limpio = t.replace(/Ɵ/g, 'ti');
    const m = limpio.match(RE_CONDOR);
    if (m) actual = { referencia: m[1], modelo: m[2] };
    const talla = m ? [m[3], m[4], m[5]] : actual && limpio.match(RE_CONDOR_TALLA)?.slice(1);
    if (!talla) return [];
    return [{ marca: 'Cóndor', ...actual, color: 'Surtido', talla: Number(talla[0]), cantidad: Number(talla[1]), coste_cent: parseImporteEs(talla[2]), pvp_cent: null }];
  });
}

/* ---------- Emparejar unidades con tallas por posición (pedidos de Etika y Victoria) ---------- */

const esNumero = (s) => /^\d{1,2}$/.test(s.trim());
const masCercana = (items, x, tolerancia) => items.reduce((best, it) => {
  const d = Math.abs(it.x - x);
  return d <= tolerancia && (!best || d < Math.abs(best.x - x)) ? it : best;
}, null);

/* Etika (pedido):
 *   Modelo: /Style 10631 PLOMO Surtido: 8Q PVPR Precio Cantidad
 *   25 26 27 28 29 30 31 32            (tallas)
 *   35,95 14,40 8                      (PVPR, precio, cantidad total)
 *   1 1 1 1 1 1 1 1   Bultos: 1 X 8    (composición de una caja, bajo cada talla) */
const X_ETIKA_TALLAS = 300;

function etika(lines) {
  const out = [];
  let modelo = null;
  for (const l of lines) {
    const cab = l.text.match(/Modelo:\s*\/Style\s+(\d+)\s+(.+?)\s+Surtido:/);
    if (cab) { modelo = { referencia: cab[1], color: titulo(cab[2]), tallas: null, precio: null, pvp: null, total: null }; continue; }
    if (!modelo) continue;
    const enTallas = l.items.filter((i) => i.x < X_ETIKA_TALLAS && esNumero(i.s));
    const importes = l.items.filter((i) => /^\d+,\d{2}$/.test(i.s.trim()));
    if (importes.length === 2) {
      modelo.pvp = parseImporteEs(importes[0].s.trim());
      modelo.precio = parseImporteEs(importes[1].s.trim());
      modelo.total = Number(l.items.find((i) => i.x > importes[1].x && /^\d+$/.test(i.s.trim()))?.s ?? 0);
      continue;
    }
    if (!enTallas.length) continue;
    if (!modelo.tallas) { modelo.tallas = enTallas; continue; }
    const caja = enTallas.map((q) => ({ talla: masCercana(modelo.tallas, q.x, 12), n: Number(q.s) })).filter((q) => q.talla && q.n);
    const porCaja = caja.reduce((s, q) => s + q.n, 0);
    const cajas = porCaja && modelo.total ? modelo.total / porCaja : 1;
    for (const q of caja) {
      out.push({ marca: 'Etika', referencia: modelo.referencia, modelo: modelo.referencia, color: modelo.color, talla: Number(q.talla.s), cantidad: Math.round(q.n * cajas), coste_cent: modelo.precio, pvp_cent: modelo.pvp });
    }
    modelo = null;
  }
  return out;
}

/* Victoria (confirmación de pedido): dos filas «TALLA:» (16-33 y 34-49) con
 * las unidades justo debajo de cada talla, y los precios por serie a la izquierda:
 *   MODELO 1080117 COLOR LEOPARDO
 *   SERIE PC PVPR TALLA: 16 17 … 33
 *                 1 1 1 …                    (bajo cada talla)
 *   22/27 20,80 49,90 CANTIDAD:
 *   TALLA: 34 35 … 49
 *   CANTIDAD: 1 1 1 1 1 1                    (bajo cada talla)
 *   CANTIDAD: 15                             (total del modelo) */
const X_VICTORIA_TALLAS = 230;

function victoria(lines) {
  const out = [];
  let m = null;
  const cerrar = () => {
    if (!m) return;
    for (const [talla, cantidad] of m.unidades) {
      const serie = m.series.find((s) => talla >= s.desde && talla <= s.hasta);
      out.push({ marca: 'Victoria', referencia: m.referencia, modelo: m.referencia, color: m.color, talla, cantidad, coste_cent: serie?.pc ?? null, pvp_cent: serie?.pvpr ?? null });
    }
    m = null;
  };
  for (const l of lines) {
    const cab = l.text.match(/^MODELO\s+(\d+)\s+COLOR\s+(.+)$/);
    if (cab) { cerrar(); m = { referencia: cab[1], color: titulo(cab[2]), filas: [], series: [], unidades: new Map() }; continue; }
    if (!m) continue;
    if (/^IMPORTE:/.test(l.text)) { cerrar(); continue; }
    const serie = l.text.match(/^(?:(\d{2})\/(\d{2})|UNICA)\s+(\d+,\d{2})\s+(\d+,\d{2})/);
    if (serie) m.series.push({ desde: Number(serie[1] ?? 0), hasta: Number(serie[2] ?? 0), pc: parseImporteEs(serie[3]), pvpr: parseImporteEs(serie[4]) });
    const numeros = l.items.filter((i) => i.x >= X_VICTORIA_TALLAS && esNumero(i.s));
    if (/TALLA:/.test(l.text)) {
      // Talla única (complementos): cuenta como «sin talla» (0).
      const unica = l.items.find((i) => i.x >= X_VICTORIA_TALLAS && /^UNICA$/i.test(i.s.trim()));
      m.filas.push(unica ? [{ x: unica.x, s: '0' }] : numeros);
      continue;
    }
    const fila = m.filas.at(-1);
    if (!fila || !numeros.length) continue;
    for (const q of numeros) {
      const t = masCercana(fila, q.x, 8);
      if (t) m.unidades.set(Number(t.s), (m.unidades.get(Number(t.s)) ?? 0) + Number(q.s));
    }
  }
  cerrar();
  return out;
}

const LECTORES = Object.freeze({ garvalin, titanitos, pablosky, condor, etika, victoria });

/** Productos de un documento según su lector (o [] si no tiene). */
export function lineasDe(parserId, pdfText) {
  return LECTORES[parserId]?.(pdfText.lines) ?? [];
}
