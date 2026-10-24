// LEJAN BRAND SL. Formato (fechas en inglés, importes con punto decimal):
//   FACTURA DE VENTA Nº F2616961
//   Fecha: August 31, 2026 Vencimiento: September 30, 2026
//   Pedido 105099 · Albarán 111717 — August 31, 2026   (una línea por albarán)
//   Total EUR IVA incl. 534.50
//   Forma pago Transferencia 30 Dias
import { matchFirst, parseFecha, parseImporteEn, RE_IMPORTE_EN, RE_FECHA_EN, unique } from './utils.js';

const CIF = 'B44612695';

export const lejan = {
  id: 'lejan',
  nombre: 'Lejan',
  detect: (text) => text.includes(CIF) || /LEJAN BRAND/i.test(text),
  parse({ lines }) {
    const cabecera = matchFirst(lines, /FACTURA DE VENTA\s+N[ºo°]\s*([A-Z0-9-]+)/);
    const pedidoCab = matchFirst(lines, /^PEDIDO\s+N[ºo°]\s*([A-Z0-9-]+)/i);
    const tipo = cabecera ? 'factura' : 'pedido';
    const numero = cabecera ?? pedidoCab;

    const fechaLinea = matchFirst(lines, new RegExp(`Fecha:\\s*(${RE_FECHA_EN.source})`));
    const fecha = parseFecha(fechaLinea ?? '');
    const vtoTexto = matchFirst(lines, new RegExp(`Vencimiento:?\\s*(${RE_FECHA_EN.source})`));
    const total = parseImporteEn(matchFirst(lines, new RegExp(`Total EUR IVA incl\\.\\s*(${RE_IMPORTE_EN.source})`)) ?? '');

    const pedidos = [];
    const albaranes = [];
    const entregas = [];
    const reEnvio = new RegExp(`Pedido\\s+(\\d+)\\s*[·•]\\s*Albar[áa]n\\s+(\\d+)\\s*[—–-]\\s*(${RE_FECHA_EN.source})`);
    for (const l of lines) {
      const m = l.text.match(reEnvio);
      if (!m) continue;
      pedidos.push(m[1]);
      albaranes.push(m[2]);
      const f = parseFecha(m[3]);
      if (f) entregas.push(f);
    }
    const refPedido = matchFirst(lines, /Su referencia\s*[·•]\s*Pedido\s+(\d+)/);
    if (refPedido) pedidos.push(refPedido);

    const vencimientos = [];
    const fechaVto = parseFecha(vtoTexto ?? '');
    if (tipo === 'factura' && fechaVto && total != null) {
      vencimientos.push({ fecha: fechaVto, importe_cent: total });
    }

    return {
      tipo,
      proveedor: { nombre: 'LEJAN BRAND SL', cif: CIF },
      numero,
      fecha,
      total_cent: total,
      vencimientos,
      pedidos: unique(pedidos),
      albaranes: unique(albaranes),
      fecha_entrega: entregas.sort()[0] ?? null,
      forma_pago: matchFirst(lines, /Forma pago\s+(.+?)(?:\s+M[ée]todo|$)/)?.trim() ?? null,
      avisos: [],
    };
  },
};
