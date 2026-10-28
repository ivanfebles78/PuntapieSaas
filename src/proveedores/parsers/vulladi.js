// VULLADI (C.I.F. ES-B-03-048931). El PDF trae espacios falsos dentro de cada
// fragmento: entre cifras («1 1 9 8 - 4 0 6») y detrás de las letras estrechas
// I, J y L («L EOPARDO I RI SADO- BEI G»). Las palabras de verdad van en
// fragmentos distintos («SUEDE» | «MARI NO»), así que solo se quitan esos.
//   CODIGO FECHA FACTURA Nº FACTURA → 8.155 15/10/2026 17.788
//   MODELO SERIE CONCEPTO PARES PRECIO IMPORTE
//   1198-406 28/30 SUEDE MARINO 3 19,57 58,71        (serie 28/30 = tallas 28, 29 y 30)
//   ALBARAN 2179
//   TOTALES...... 104 1.785,96
//   IMPORTES 595,32 595,32 595,32
//   GIRO VENCIMIENTOS 14/11/2026 14/12/2026 13/01/2027
// Si los pares coinciden con las tallas de la serie, va 1 de cada una; si no,
// la serie queda como tramo para repartirla a mano.
import { filasDeTramo } from './lineas.js';
import { parseFecha, parseImporteEs, titulo } from './utils.js';

const CIF = 'B03048931';
const MARCA = 'Vulladi';

const limpiar = (s) => s.trim().replace(/(?<=[IJL\d.,/-]) (?=\S)/g, '');
const juntar = (l) => l.items.map((i) => limpiar(i.s)).filter(Boolean).join(' ');
const RE_LINEA = /^(\d{3,5}-\d{2,4})\s+(\d{2})\/(\d{2})\s+(.+?)\s+(\d+)\s+(\d+,\d{2})\s+[\d.]+,\d{2}$/;
const RE_IMPORTES_G = /\d{1,3}(?:\.\d{3})*,\d{2}/g;
const RE_FECHAS_G = /\d{2}\/\d{2}\/\d{4}/g;

export function lineasVulladi(texts) {
  return texts.flatMap((t, i) => {
    const m = t.match(RE_LINEA);
    if (!m) return [];
    const [, referencia, desde, hasta, concepto, pares, precio] = m;
    const base = { marca: MARCA, referencia, modelo: referencia, color: titulo(concepto), coste_cent: parseImporteEs(precio), pvp_cent: null };
    const d = Number(desde);
    const h = Number(hasta);
    const total = Number(pares);
    if (total === h - d + 1) return Array.from({ length: total }, (_, k) => ({ ...base, talla: d + k, cantidad: 1 }));
    return filasDeTramo(base, { desde: d, hasta: h, total, id: `v${i}` });
  });
}

export const vulladi = {
  id: 'vulladi',
  nombre: 'Vulladi',
  detect: (text) => /ES-B-03-048931/.test(text) || text.includes(CIF),
  parse({ lines }) {
    const texts = lines.map(juntar);
    const cab = texts.map((t) => t.match(/^([\d.]+)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.]+)$/)).find(Boolean);
    const totales = texts.map((t) => t.match(/^TOTALES[\s.]*(\d+)\s+([\d.]+,\d{2})$/)).find(Boolean);
    const importes = [...(texts.find((t) => /^IMPORTES\b/.test(t)) ?? '').matchAll(RE_IMPORTES_G)].map((x) => parseImporteEs(x[0]));
    const fechas = [...(texts.find((t) => /VENCIMIENTOS/.test(t)) ?? '').matchAll(RE_FECHAS_G)].map((x) => parseFecha(x[0]));
    const vencimientos = fechas.flatMap((f, i) => (f && importes[i] != null ? [{ fecha: f, importe_cent: importes[i] }] : []));
    const lineas = lineasVulladi(texts);
    const leidos = lineas.reduce((s, l) => s + (l.tramo ? 0 : l.cantidad), 0)
      + [...new Map(lineas.filter((l) => l.tramo).map((l) => [l.tramo.id, l.tramo.total])).values()].reduce((a, b) => a + b, 0);
    const paresPdf = totales ? Number(totales[1]) : null;
    return {
      tipo: 'factura',
      proveedor: { nombre: 'Vulladi', cif: CIF },
      numero: cab ? cab[3].replace(/\./g, '') : null,
      fecha: cab ? parseFecha(cab[2]) : null,
      total_cent: totales ? parseImporteEs(totales[2]) : null,
      vencimientos,
      pedidos: [],
      albaranes: texts.flatMap((t) => t.match(/^ALBARAN\s+(\d+)/)?.[1] ?? []),
      fecha_entrega: null,
      forma_pago: texts.find((t) => /VENCIMIENTOS/.test(t))?.match(/^(\S+)\s+VENCIMIENTOS/)?.[1] ?? null,
      lineas,
      avisos: paresPdf != null && paresPdf !== leidos ? [`Se han leído ${leidos} pares y la factura indica ${paresPdf}: revisa los productos.`] : [],
    };
  },
};
