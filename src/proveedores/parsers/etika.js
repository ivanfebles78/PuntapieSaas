// ETIKA URBAN SHOES, S.L.U. Pedidos (bilingüe):
//   /Order _No 2600412
//   Fecha de Pedido:
//   25/02/2026
//   Fecha Aproximada de Servicio: 01/09/2026
//   F. Pago: 60 DIAS IBAN: ...
//   Total Cantidad Bruto Base Imponible
//   Taxes not included
//   160 2.310,00 2.310,00          (último importe = base imponible)
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst } from './utils.js';

const CIF = 'B56662349';
const RE_IMPORTES_G = new RegExp(RE_IMPORTE_ES.source, 'g');

export const etika = {
  id: 'etika',
  nombre: 'Etika',
  detect: (text) => text.includes(CIF) || /ETIKA URBAN SHOES/i.test(text),
  parse({ lines }) {
    const texts = lines.map((l) => l.text);
    const L = texts.map((text) => ({ text }));
    const esFactura = texts.some((t) => /\bFACTURA\b/i.test(t) && !/PROFORMA/i.test(t));

    const numero = matchFirst(L, /\/Order _?No\s+(\d+)/) ?? matchFirst(L, /Pedido N[ºo°]:\s*(\d+)/);

    let fecha = null;
    const idxFecha = texts.findIndex((t) => /Fecha de Pedido:/.test(t));
    if (idxFecha >= 0) {
      const enLinea = parseFecha(texts[idxFecha].split(/Fecha de Pedido:/)[1] ?? "");
      fecha = enLinea ?? parseFecha(texts[idxFecha + 1] ?? '');
    }
    const entrega = parseFecha(matchFirst(L, new RegExp(`Fecha Aproximada de Servicio:\\s*(${RE_FECHA_DMY.source})`)) ?? '');

    let total = null;
    const idxTotal = texts.findIndex((t) => /^Total Cantidad\s+Bruto/.test(t));
    for (let i = idxTotal + 1; idxTotal >= 0 && i < idxTotal + 5; i += 1) {
      const importes = [...(texts[i] ?? '').matchAll(RE_IMPORTES_G)].map((m) => parseImporteEs(m[0]));
      if (importes.length) { total = importes[importes.length - 1]; break; }
    }

    return {
      tipo: esFactura ? 'factura' : 'pedido',
      proveedor: { nombre: 'ETIKA URBAN SHOES, S.L.U.', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos: [],
      pedidos: [],
      albaranes: [],
      fecha_entrega: entrega,
      forma_pago: matchFirst(L, /^F\. Pago:\s*(.+?)(?:\s+IBAN:.*)?$/)?.trim() ?? null,
      avisos: [],
    };
  },
};
