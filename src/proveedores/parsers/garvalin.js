// INTERNATIONAL SHOES GARVALIN S.L. (Biomecanics / Garvalín). Formato:
//   Doc. Nº 2613709          Fecha 02/09/2026 0:00:00
//   ALBARÁN 2621494          (uno por cada albarán facturado)
//   Total neto EUR 3.815,90
//   GIRO CORE Falso 01/11/2026 0:00:00 1.271,84   (vencimientos, última página)
//   Falso 16/11/2026 0:00:00 1.271,84
import { matchFirst, matchAll, parseFecha, parseImporteEs, RE_IMPORTE_ES } from './utils.js';

const CIF = 'B03406949';

export const garvalin = {
  id: 'garvalin',
  nombre: 'Garvalín',
  detect: (text) => text.includes(CIF) || /GARVALIN S\.L\./i.test(text),
  parse({ lines }) {
    const avisos = [];
    const numero = matchFirst(lines, /Doc\.\s*N[ºo°]\s+(\d+)/);
    const fecha = parseFecha(matchFirst(lines, /^Fecha\s+(\d{2}\/\d{2}\/\d{4})/) ?? '');
    const total = parseImporteEs(matchFirst(lines, new RegExp(`Total neto EUR\\s+(${RE_IMPORTE_ES.source})`)) ?? '');
    const albaranes = matchAll(lines, /ALBAR[ÁA]N\s+(\d+)/);

    const vencimientos = [];
    const reVto = new RegExp(`Falso\\s+(\\d{2}/\\d{2}/\\d{4})(?:\\s+\\d{1,2}:\\d{2}:\\d{2})?\\s+(${RE_IMPORTE_ES.source})`, 'g');
    for (const l of lines) {
      for (const m of l.text.matchAll(reVto)) {
        vencimientos.push({ fecha: parseFecha(m[1]), importe_cent: parseImporteEs(m[2]) });
      }
    }

    const formaPago = matchFirst(lines, /FORMA DE PAGO:\s*([A-Z_ ]+)/)?.replace(/_/g, ' ').trim()
      ?? matchFirst(lines, /^(GIRO[A-Z ]*)\s+Falso/);
    const tipo = /PEDIDO|PROFORMA/.test(lines.slice(0, 20).map((l) => l.text).join(' ')) && !/FACTURA/.test(lines.slice(0, 20).map((l) => l.text).join(' '))
      ? 'pedido' : 'factura';

    return {
      tipo,
      proveedor: { nombre: 'INTERNATIONAL SHOES GARVALIN S.L.', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos,
      pedidos: [],
      albaranes,
      fecha_entrega: fecha,
      forma_pago: formaPago ?? null,
      avisos,
    };
  },
};
