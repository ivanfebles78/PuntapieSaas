// JEMMA FOOTWEAR, S.L. (Titanitos). Formato bilingüe:
//   16/10/25 FAC25//2502572            (fecha y número en la misma línea)
//   Nº pedido 25000933 Fecha Entrega/ 16/10/25   (un bloque por pedido)
//   Nº albarán 25003193 Delivery date
//   Total FACTURA / INVOICE: 1.155,20 EUR
//   Fecha Vto. e importe: 25/12/25 577,60 EUR    (uno por vencimiento)
//   Payment / Forma pago: Giro cliente Total de Albaranes: 1 ...
import { matchFirst, matchAll, parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, unique } from './utils.js';

const CIF = 'B53062295';

export const titanitos = {
  id: 'titanitos',
  nombre: 'Titanitos',
  detect: (text) => text.includes(CIF) || /JEMMA FOOTWEAR/i.test(text),
  parse({ lines }) {
    let numero = null;
    let fecha = null;
    for (const l of lines) {
      const m = l.text.match(new RegExp(`^(${RE_FECHA_DMY.source})\\s+((?:FAC|PED|ALB)[A-Z0-9/]+)$`));
      if (m) { fecha = parseFecha(m[1]); numero = m[5]; break; }
    }
    const tipo = numero?.startsWith('PED') ? 'pedido' : 'factura';

    const total = parseImporteEs(matchFirst(lines, new RegExp(`Total FACTURA / INVOICE:\\s*(${RE_IMPORTE_ES.source})`)) ?? '');
    const pedidos = matchAll(lines, /N[ºo°] pedido\s+(\d+)/);
    const albaranes = matchAll(lines, /N[ºo°] albar[áa]n\s+(\d+)/);
    const entregas = matchAll(lines, new RegExp(`Fecha Entrega/?\\s+(${RE_FECHA_DMY.source})`))
      .map(parseFecha).filter(Boolean).sort();

    const vencimientos = [];
    const reVto = new RegExp(`Fecha Vto\\. e importe:\\s*(${RE_FECHA_DMY.source})\\s+(${RE_IMPORTE_ES.source})`);
    for (const l of lines) {
      const m = l.text.match(reVto);
      if (m) vencimientos.push({ fecha: parseFecha(m[1]), importe_cent: parseImporteEs(m[5]) });
    }
    vencimientos.sort((a, b) => a.fecha.localeCompare(b.fecha));

    return {
      tipo,
      proveedor: { nombre: 'JEMMA FOOTWEAR, S.L. (Titanitos)', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos,
      pedidos: unique(pedidos),
      albaranes: unique(albaranes),
      fecha_entrega: entregas[0] ?? null,
      forma_pago: matchFirst(lines, /Forma pago:\s*(.+?)\s+Total de Albaranes/)?.trim() ?? null,
      avisos: [],
    };
  },
};
