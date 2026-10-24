// CALZADOS PABLO S.L.U. (Pablosky). Formato (cabecera en tabla, valores debajo):
//   Nº Factura Fecha Página ...
//   24/20364 17/02/2025 1
//   Forma pago Agencia Representante Bultos Nº Albaran Nº Orden
//   TRANSFERENCIA TRANSARRIO VILLAESCUSA, JORGE 0 VALB096187 00450C
//   Suma Importes % Imp. Dto. ... Total Euros
//   2.532,23 2,00 50,64 2.481,59 2.481,59      (el último importe es el total)
//   V E N C I M I E N T O S
//   17/02/2025
//   2.481,59 0049 5320 54 221831****
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst, unique } from './utils.js';

const CIF = 'B45007671';
const RE_SOLO_IMPORTES = new RegExp(`^(?:${RE_IMPORTE_ES.source})(?:\\s+(?:${RE_IMPORTE_ES.source}))*$`);

export const pablosky = {
  id: 'pablosky',
  nombre: 'Pablosky',
  detect: (text) => text.includes(CIF) || /CALZADOS PABLO S\.L\.U\./i.test(text),
  parse({ lines }) {
    const texts = lines.map((l) => l.text);
    const esFactura = texts.some((t) => /N[ºo°] Factura/.test(t));

    let numero = null;
    let fecha = null;
    for (const t of texts) {
      const m = t.match(/^(\d{2}\/\d{5,})\s+(\d{2}\/\d{2}\/\d{4})\s+\d+$/);
      if (m) { numero = m[1]; fecha = parseFecha(m[2]); break; }
    }

    const albaranes = unique(texts.flatMap((t) => t.match(/\b(VALB\d+)\b/g) ?? []));
    const pedidos = [];
    let formaPago = null;
    const idxCab = texts.findIndex((t) => /^Forma pago\s+Agencia/.test(t));
    if (idxCab >= 0 && texts[idxCab + 1]) {
      const valores = texts[idxCab + 1];
      formaPago = valores.split(/\s+/)[0] ?? null;
      const m = valores.match(/VALB\d+\s+(\S+)$/);
      if (m) pedidos.push(m[1]);
    }

    let total = null;
    const idxSuma = texts.findIndex((t) => /^Suma Importes/.test(t) && /Total Euros/.test(t));
    for (let i = 0; i < texts.length; i += 1) {
      if (!/^Suma Importes/.test(texts[i])) continue;
      const siguiente = texts[i + 1] ?? '';
      if (RE_SOLO_IMPORTES.test(siguiente)) {
        const importes = siguiente.split(/\s+/);
        total = parseImporteEs(importes[importes.length - 1]);
        break;
      }
    }
    if (total == null && idxSuma < 0) {
      total = parseImporteEs(matchFirst(lines, new RegExp(`Total Euros\\s+(${RE_IMPORTE_ES.source})`)) ?? '');
    }

    const vencimientos = [];
    const idxVto = texts.findIndex((t) => /^V\s*E\s*N\s*C\s*I\s*M\s*I\s*E\s*N\s*T\s*O\s*S/.test(t));
    if (idxVto >= 0) {
      const fechas = [];
      const importes = [];
      for (let i = idxVto + 1; i < texts.length && i < idxVto + 12; i += 1) {
        const t = texts[i];
        if (/Calzados Pablo, S\.L\.U\./.test(t)) break;
        for (const m of t.matchAll(new RegExp(RE_FECHA_DMY.source, 'g'))) fechas.push(parseFecha(m[0]));
        for (const m of t.matchAll(new RegExp(RE_IMPORTE_ES.source, 'g'))) importes.push(parseImporteEs(m[0]));
      }
      fechas.forEach((f, i) => {
        if (f && importes[i] != null) vencimientos.push({ fecha: f, importe_cent: importes[i] });
      });
    }

    return {
      tipo: esFactura ? 'factura' : 'pedido',
      proveedor: { nombre: 'CALZADOS PABLO S.L.U. (Pablosky)', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos,
      pedidos: unique(pedidos),
      albaranes,
      fecha_entrega: fecha,
      forma_pago: formaPago,
      avisos: [],
    };
  },
};
