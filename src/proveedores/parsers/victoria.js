// CALZADOS NUEVO MILENIO, S.L.U. (Calzados Victoria). El mismo pedido llega en tres formatos:
//   Hoja de pedido:   Pedido N: 5501945 / Fecha de Pedido: 04/02/26 / Fecha de Servicio: 1ªQ OCT
//                     BRUTO BASE % IVA CUOTA TOTAL TOTAL.- 153 → 3.877,75 3.877,75 3.877,75
//   Confirmación:     PEDIDO NO.: 5501945 / FECHA PEDIDO: 04/02/2026 / FECHA SERVICIO SOLICITADA: 1ªQ OCT
//                     TOTAL 3.877,75 EUR
//   Factura proforma: FECHA PEDIDO Nº Nº CLIENTE ... → 04/02/26 5501945 6103 ; ... IMPORTE TOTAL → 3.877,75 3.877,75
// Los tres son el mismo pedido (no una factura): la proforma es la petición de pago anticipado.
// La fecha de servicio viene como quincena ("1ªQ OCT"); se aproxima al día 1 o 16 del mes.
import { filasDeTramo } from './lineas.js';
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst, titulo, unique } from './utils.js';

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
    if (lines.some((l) => /^FACTURA NO\.?:/i.test(l.text))) return parseFactura(lines);
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

/* ---------- Factura de venta ----------
 *   FECHA : 20/10/26 · FACTURA NO.: 26FV23615 · PEDIDO NO.: 5501945
 *   Nº ALBARÁN FECHA MODELO COLOR DESCRIPCION PAÍS ARANCEL PESO SERIE CANTIDAD PRECIO IMPORTE
 *   26AL31292/550 19/10/26 1124131 BEIGE TIEMPO TIRAS CN 6403999300 0,00 28/35 6 Pares 23,30 139,80
 *   1945                           SERRAJE FANTASIA       (sigue el albarán /5501945 y la descripción)
 *   1080117 LEOPARD GONG-FU …      y debajo «O BAILARINA» (el color sigue: LEOPARDO)
 *   VENCIMIENTO E IMPORTES: 20/10/26 - 3.852,80 EUR
 * La serie 22/28 son las tallas 22 a 28: si los pares coinciden con las tallas
 * va 1 de cada una; si no, se reparte a mano. «UNICA» = sin talla.
 */
const RE_FILA = /^(?:(\S+)\/\d+\s+\d{2}\/\d{2}\/\d{2}\s+)?(\d{6,8})\s+(\S+)\s+(.+?)\s+[A-Z]{2}\s+\d{8,10}\s+[\d.,]+\s+(\d{2}\/\d{2}|UNICA)\s+(\d+)\s+(?:Pares|Unidades)\s+(\d+,\d{2})\s+[\d.]+,\d{2}$/i;
const X_COLOR = [140, 185];
const X_DESCRIPCION = [185, 275];
const en = (i, [a, b]) => i.x >= a && i.x < b;

export function lineasFacturaVictoria(lines) {
  const filas = [];
  for (const l of lines) {
    const m = l.text.match(RE_FILA);
    if (m) {
      filas.push({ albaran: m[1] ?? null, referencia: m[2], color: m[3], descripcion: [m[4]], serie: m[5], pares: Number(m[6]), precio: parseImporteEs(m[7]) });
      continue;
    }
    const f = filas.at(-1);
    if (!f || /^(CONDICIONES|FORMA DE PAGO|De conformidad|FACTURA DE VENTA)/.test(l.text)) { if (f) f.cerrada = true; continue; }
    if (f.cerrada) continue;
    // Continuación: el color y la descripción que no cabían en su columna.
    for (const i of l.items) {
      if (en(i, X_COLOR)) f.color += i.s.trim();
      else if (en(i, X_DESCRIPCION)) f.descripcion.push(i.s.trim());
    }
  }
  return filas.flatMap((f, n) => {
    const base = {
      marca: 'Victoria', referencia: f.referencia, modelo: titulo(f.descripcion.join(' ').replace(/\s*&$/, '')),
      color: titulo(f.color), coste_cent: f.precio, pvp_cent: null,
    };
    if (/^UNICA$/i.test(f.serie)) return [{ ...base, talla: 0, cantidad: f.pares }];
    const [desde, hasta] = f.serie.split('/').map(Number);
    if (f.pares === hasta - desde + 1) return Array.from({ length: f.pares }, (_, k) => ({ ...base, talla: desde + k, cantidad: 1 }));
    return filasDeTramo(base, { desde, hasta, total: f.pares, id: `vf${n}` });
  });
}

function parseFactura(lines) {
  const texts = lines.map((l) => l.text);
  const L = texts.map((text) => ({ text }));
  const lineas = lineasFacturaVictoria(lines);
  const vtos = [...(matchFirst(L, /VENCIMIENTO E IMPORTES:\s*(.+?)(?:\s+BASE IMPONIBLE.*)?$/i) ?? '')
    .matchAll(/(\d{2}\/\d{2}\/\d{2,4})\s*-\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g)]
    .map((m) => ({ fecha: parseFecha(m[1]), importe_cent: parseImporteEs(m[2]) })).filter((v) => v.fecha);
  const totalUds = Number(matchFirst(L, /TOTAL CANTIDAD:\s*(\d+)/i) ?? NaN);
  const leidas = lineas.reduce((s, l) => s + (l.tramo ? 0 : l.cantidad), 0)
    + [...new Map(lineas.filter((l) => l.tramo).map((l) => [l.tramo.id, l.tramo.total])).values()].reduce((a, b) => a + b, 0);
  const pedido = matchFirst(L, /^PEDIDO NO\.?:\s*(\d+)/i);
  return {
    tipo: 'factura',
    proveedor: { nombre: 'CALZADOS NUEVO MILENIO, S.L.U. (Victoria)', cif: CIF },
    numero: matchFirst(L, /^FACTURA NO\.?:\s*(\S+)/i),
    fecha: parseFecha(matchFirst(L, /^FECHA\s*:\s*(\S+)/i) ?? ''),
    total_cent: parseImporteEs(matchFirst(L, new RegExp(`^TOTAL\\s+(${RE_IMPORTE_ES.source})\\s*EUR`, 'i')) ?? ''),
    vencimientos: vtos,
    pedidos: pedido ? [pedido] : [],
    albaranes: unique(texts.flatMap((t) => t.match(/^(\d{2}AL\d+)\//)?.[1] ?? [])),
    fecha_entrega: null,
    forma_pago: matchFirst(L, /FORMA DE PAGO:\s*(.+?)\s+TOTAL CANTIDAD/i)?.trim() ?? null,
    lineas,
    avisos: Number.isFinite(totalUds) && totalUds !== leidas ? [`Se han leído ${leidas} unidades y la factura indica ${totalUds}: revisa los productos.`] : [],
  };
}
