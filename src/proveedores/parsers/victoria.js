// CALZADOS NUEVO MILENIO, S.L.U. (Calzados Victoria). El mismo pedido llega en tres formatos:
//   Hoja de pedido:   Pedido N: 5501945 / Fecha de Pedido: 04/02/26 / Fecha de Servicio: 1ªQ OCT
//                     BRUTO BASE % IVA CUOTA TOTAL TOTAL.- 153 → 3.877,75 3.877,75 3.877,75
//   Confirmación:     PEDIDO NO.: 5501945 / FECHA PEDIDO: 04/02/2026 / FECHA SERVICIO SOLICITADA: 1ªQ OCT
//                     TOTAL 3.877,75 EUR
//   Factura proforma: FECHA PEDIDO Nº Nº CLIENTE ... → 04/02/26 5501945 6103 ; ... IMPORTE TOTAL → 3.877,75 3.877,75
// Los tres son el mismo pedido (no una factura): la proforma es la petición de pago anticipado.
// La fecha de servicio viene como quincena ("1ªQ OCT"); se aproxima al día 1 o 16 del mes.
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst } from './utils.js';

const CIF = 'B26287037';
const RE_IMPORTES_G = new RegExp(RE_IMPORTE_ES.source, 'g');
const MESES = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12 };

/** "1ªQ OCT" con fecha de pedido 2026-02-04 → 2026-10-01; "2ªQ" → día 16. Si el mes ya pasó, año siguiente. */
export function quincenaAFecha(texto, fechaPedido) {
  const m = String(texto ?? '').toUpperCase().match(/([12])\s*[ªA]?\s*Q\s+([A-Z]{3})/);
  if (!m || !MESES[m[2]] || !fechaPedido) return null;
  const mes = MESES[m[2]];
  const [anioPedido, mesPedido] = fechaPedido.split('-').map(Number);
  const anio = mes < mesPedido ? anioPedido + 1 : anioPedido;
  return `${anio}-${String(mes).padStart(2, '0')}-${m[1] === '1' ? '01' : '16'}`;
}

export const victoria = {
  id: 'victoria',
  nombre: 'Victoria',
  detect: (text) => text.includes(CIF) || /NUEVO MILENIO/i.test(text) || /calzadosvictoria\.com/i.test(text),
  parse({ lines }) {
    const texts = lines.map((l) => l.text);
    const L = texts.map((text) => ({ text }));
    const avisos = [];

    let numero = matchFirst(L, /^PEDIDO NO\.?:\s*(\d+)/i) ?? matchFirst(L, /^Pedido N[ºo°]?:\s*(\d+)/);
    let fecha = parseFecha(matchFirst(L, /^(?:FECHA PEDIDO|Fecha de Pedido):\s*(\S+)/i) ?? '');
    if (!numero) {
      // Proforma: cabecera en tabla, valores en la línea siguiente: "04/02/26 5501945 6103"
      const idx = texts.findIndex((t) => /^FECHA\s+PEDIDO N[ºo°]/i.test(t));
      const m = texts[idx + 1]?.match(new RegExp(`^(${RE_FECHA_DMY.source})\\s+(\\d+)`));
      if (m) { fecha = parseFecha(m[1]); numero = m[5]; }
    }

    let total = null;
    const lineaTotal = matchFirst(L, new RegExp(`^TOTAL\\s+(${RE_IMPORTE_ES.source})\\s*EUR`, 'i'));
    if (lineaTotal) total = parseImporteEs(lineaTotal);
    if (total == null) {
      const idx = texts.findIndex((t) => /^BRUTO\b.*\b(TOTAL|IMPORTE TOTAL)\b/.test(t));
      for (let i = idx + 1; idx >= 0 && i < idx + 4; i += 1) {
        const importes = [...(texts[i] ?? '').matchAll(RE_IMPORTES_G)].map((m) => parseImporteEs(m[0]));
        if (importes.length) { total = importes[importes.length - 1]; break; }
      }
    }

    const servicio = matchFirst(L, /FECHA CONFIRMADA:\s*(\d\s*[ªa]?\s*Q\s+[A-Za-z]{3})/i)
      ?? matchFirst(L, /(?:FECHA SERVICIO SOLICITADA|Fecha de Servicio):\s*(\d\s*[ªa]?\s*Q\s+[A-Za-z]{3})/i);
    const fechaEntrega = quincenaAFecha(servicio, fecha);
    if (servicio) avisos.push(`Fecha de servicio «${servicio.trim()}» aproximada al ${fechaEntrega ?? '?'}.`);

    return {
      tipo: 'pedido',
      proveedor: { nombre: 'CALZADOS NUEVO MILENIO, S.L.U. (Victoria)', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos: [],
      pedidos: [],
      albaranes: [],
      fecha_entrega: fechaEntrega,
      forma_pago: matchFirst(L, /(?:FORMA DE PAGO|Forma de Pago):\s*(.+?)(?:\s{2,}|\s+(?:Poblaci[óo]n|FECHA VALOR).*)?$/i)?.trim()
        ?? matchFirst(L, /^(PAGO ANTICIPADO[^\n]*?)\s+\d{2}\/\d{2}\/\d{2}$/)?.trim() ?? null,
      avisos,
    };
  },
};
