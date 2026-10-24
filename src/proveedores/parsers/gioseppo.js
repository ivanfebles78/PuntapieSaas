// GIOSEPPO, S.L.U. Dos documentos:
//
// Factura (el número va partido en dos líneas):
//   B76766294 FAC-GI26- 13/08/2026 RICARDO BERNARDO
//   00016722 SANTANA MORALES
//   P-G-2026080619 DDP 6 0.554 ...                (pedidos de venta)
//   Albarán Nº ALB-GI-001399256 Fecha: 12/08/2026 ...
//   Total Base Imp. 3% IGIC Total Factura
//   2.029,19 2029,19 60,88 2.090,07 €
//   Forma de pago: GIRO 90 DIAS
//   29/11/2026                                     (vencimientos: fechas...)
//   Entidad: 001 2.090,07                          (...e importes)
//
// Confirmación de pedido:
//   07/08/2026 P-G-2026421943 1
//   ... = 9 Pares 28/02/2027 29,15 € ...           (F. Servicio = fecha de entrega)
//   Total Base Imp. IVA RE Total pedido
//   262,35 € 262,35 € IGIC 7,87 €
//   270,22 €
import { matchFirst, matchAll, parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, unique } from './utils.js';

const CIF = 'B03503034';
const NOMBRE = 'GIOSEPPO, S.L.U';
const RE_IMPORTES_G = new RegExp(RE_IMPORTE_ES.source, 'g');
const RE_FECHAS_G = new RegExp(RE_FECHA_DMY.source, 'g');

export const gioseppo = {
  id: 'gioseppo',
  nombre: 'Gioseppo',
  detect: (text) => /B-?03503034/.test(text) || /GIOSEPPO, S\.L\.U/i.test(text),
  parse({ lines }) {
    const texts = lines.map((l) => l.text);
    const esPedido = texts.some((t) => /^Fecha de pedido\s+Pedido/.test(t)) && !texts.some((t) => /Factura N[ºo°]/.test(t));
    return esPedido ? parsePedido(texts) : parseFactura(texts);
  },
};

function parseFactura(texts) {
  let numero = null;
  let fecha = null;
  for (let i = 0; i < texts.length; i += 1) {
    const m = texts[i].match(/\b(FAC-[A-Z0-9]+-)\s+(\d{2}\/\d{2}\/\d{4})/);
    if (!m) continue;
    const resto = texts[i + 1]?.match(/^(\d+)/)?.[1] ?? '';
    numero = m[1] + resto;
    fecha = parseFecha(m[2]);
    break;
  }
  // Si el número no viene partido: "FAC-GI26-00016722 13/08/2026"
  if (!numero) {
    const m = texts.map((t) => t.match(/\b(FAC-[A-Z0-9]+-\d+)\s+(\d{2}\/\d{2}\/\d{4})/)).find(Boolean);
    if (m) { numero = m[1]; fecha = parseFecha(m[2]); }
  }

  const pedidos = matchAll(texts.map((text) => ({ text })), /\b(P-G-\d+)\b/);
  const albaranes = [];
  const entregas = [];
  for (const t of texts) {
    const m = t.match(/Albar[áa]n N[ºo°]\s+(ALB-[A-Z0-9-]+)\s+Fecha:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (m) { albaranes.push(m[1]); entregas.push(parseFecha(m[2])); }
  }

  let total = null;
  const idxTotal = texts.findIndex((t) => /^Total Base Imp\./.test(t) && /Total Factura/.test(t));
  if (idxTotal >= 0) {
    const importes = [...(texts[idxTotal + 1] ?? '').matchAll(RE_IMPORTES_G)].map((m) => parseImporteEs(m[0]));
    if (importes.length) total = importes[importes.length - 1];
  }

  const vencimientos = [];
  const idxVto = texts.findIndex((t) => /^Forma de pago:/.test(t));
  if (idxVto >= 0) {
    const fechas = [];
    const importes = [];
    for (let i = idxVto + 1; i < texts.length && i < idxVto + 12; i += 1) {
      const t = texts[i];
      if (/^(Direcci[óo]n:|Les comunicamos)/.test(t)) break;
      for (const m of t.matchAll(RE_FECHAS_G)) fechas.push(parseFecha(m[0]));
      for (const m of t.replace(/IBAN:.*$/, '').matchAll(RE_IMPORTES_G)) importes.push(parseImporteEs(m[0]));
    }
    fechas.forEach((f, i) => {
      const importe = importes[i] ?? (fechas.length === 1 ? total : null);
      if (f && importe != null) vencimientos.push({ fecha: f, importe_cent: importe });
    });
  }

  return {
    tipo: 'factura',
    proveedor: { nombre: NOMBRE, cif: CIF },
    numero,
    fecha,
    total_cent: total,
    vencimientos,
    pedidos: unique(pedidos),
    albaranes: unique(albaranes),
    fecha_entrega: entregas.filter(Boolean).sort()[0] ?? fecha,
    forma_pago: matchFirst(texts.map((text) => ({ text })), /^Forma de pago:\s*(.+)$/)?.trim() ?? null,
    avisos: [],
  };
}

function parsePedido(texts) {
  const cab = texts.map((t) => t.match(/^(\d{2}\/\d{2}\/\d{4})\s+(P-G-\d+)\b/)).find(Boolean);
  const numero = cab?.[2] ?? null;
  const fecha = cab ? parseFecha(cab[1]) : null;

  // F. Servicio: la fecha que sigue a "= N Pares" (o "Pares") en cada línea de artículo.
  const entregas = texts
    .map((t) => t.match(/\bPares\s+(\d{2}\/\d{2}\/\d{4})/)?.[1])
    .filter(Boolean).map(parseFecha).filter(Boolean).sort();

  let total = null;
  const idxTotal = texts.findIndex((t) => /^Total Base Imp\./.test(t) && /Total pedido/.test(t));
  if (idxTotal >= 0) {
    const importes = [...`${texts[idxTotal + 1] ?? ''} ${texts[idxTotal + 2] ?? ''}`.matchAll(RE_IMPORTES_G)].map((m) => parseImporteEs(m[0]));
    if (importes.length) total = importes[importes.length - 1];
  }
  if (total == null) total = parseImporteEs(matchFirst(texts.map((text) => ({ text })), new RegExp(`IMPORTE TOTAL:\\s*(${RE_IMPORTE_ES.source})`)) ?? '');

  return {
    tipo: 'pedido',
    proveedor: { nombre: NOMBRE, cif: CIF },
    numero,
    fecha,
    total_cent: total,
    vencimientos: [],
    pedidos: [],
    albaranes: [],
    fecha_entrega: entregas[0] ?? null,
    forma_pago: matchFirst(texts.map((text) => ({ text })), /Condiciones de pago:\s*(.+?)\s+C\.P\./)?.trim() ?? null,
    avisos: [],
  };
}
