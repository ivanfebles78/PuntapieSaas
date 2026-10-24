// ARETEX, S.A. (calcetines Condor). Factura:
//   Número Fecha Envio por
//   FACTURA
//   500047 10/09/2026 TRANSPORTES DHL
//   Cliente Pedido Albarán Proveedor Su pedido
//   23.211/43 47/00572 14.638
//   Importe Neto I.V.A. Recargo Equival. Total
//   928,05 € 928,05 €
//   Vencimiento PRE-PAGO NºCuenta: ES81...
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst } from './utils.js';

const CIF = 'A08044182';
const RE_IMPORTES_G = new RegExp(RE_IMPORTE_ES.source, 'g');

export const condor = {
  id: 'condor',
  nombre: 'Condor',
  detect: (text) => /A-?08044182/.test(text) || /ARETEX, S\.A\./i.test(text),
  parse({ lines }) {
    const texts = lines.map((l) => l.text);
    const L = texts.map((text) => ({ text }));
    const esFactura = texts.some((t) => /^FACTURA\b/.test(t));

    let numero = null;
    let fecha = null;
    const idxNum = texts.findIndex((t) => /^N[úu]mero\s+Fecha/.test(t));
    for (let i = idxNum + 1; idxNum >= 0 && i < idxNum + 4; i += 1) {
      const m = texts[i]?.match(new RegExp(`^(\\d+)\\s+(${RE_FECHA_DMY.source})`));
      if (m) { numero = m[1]; fecha = parseFecha(m[2]); break; }
    }

    const pedidos = [];
    const albaranes = [];
    const idxRef = texts.findIndex((t) => /^Cliente\s+Pedido\s+Albar[áa]n/.test(t));
    if (idxRef >= 0 && texts[idxRef + 1]) {
      const [, pedido, albaran] = texts[idxRef + 1].split(/\s+/);
      if (pedido) pedidos.push(pedido);
      if (albaran) albaranes.push(albaran);
    }

    let total = null;
    const idxTotal = texts.findIndex((t) => /^Importe Neto\b.*\bTotal$/.test(t));
    if (idxTotal >= 0) {
      const importes = [...(texts[idxTotal + 1] ?? '').matchAll(RE_IMPORTES_G)].map((m) => parseImporteEs(m[0]));
      if (importes.length) total = importes[importes.length - 1];
    }

    const lineaVto = matchFirst(L, /^Vencimiento\s+(.+?)(?:\s+N[ºo°]\s*Cuenta.*)?$/);
    const fechaVto = parseFecha(lineaVto ?? '') ?? fecha;
    const vencimientos = esFactura && fechaVto && total != null ? [{ fecha: fechaVto, importe_cent: total }] : [];
    const formaPago = lineaVto && !parseFecha(lineaVto) ? lineaVto.trim() : null;

    return {
      tipo: esFactura ? 'factura' : 'pedido',
      proveedor: { nombre: 'ARETEX, S.A. (Condor)', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos,
      pedidos,
      albaranes,
      fecha_entrega: fecha,
      forma_pago: formaPago,
      avisos: [],
    };
  },
};
