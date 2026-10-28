// LEJAN BRAND SL. Formato (fechas en inglés, importes con punto decimal):
//   FACTURA DE VENTA Nº F2616961
//   Fecha: August 31, 2026 Vencimiento: September 30, 2026
//   Pedido 105099 · Albarán 111717 — August 31, 2026   (una línea por albarán)
//   Total EUR IVA incl. 534.50
//   Forma pago Transferencia 30 Dias
import { matchFirst, parseFecha, parseImporteEn, RE_IMPORTE_EN, RE_FECHA_EN, unique } from './utils.js';

const MARCA = 'Lejan';

const CIF = 'B44612695';

export const lejan = {
  id: 'lejan',
  nombre: 'Lejan',
  detect: (text) => text.includes(CIF) || /LEJAN BRAND/i.test(text),
  parse({ lines }) {
    const lineas = lineasLejan(lines);
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
      lineas,
      avisos: avisoPares(lines, lineas),
    };
  },
};

/* ---------- Productos ----------
 * Cada modelo ocupa varias líneas, con las tallas en una fila y debajo, en la
 * misma columna, los pares de cada una:
 *   TALLAS:            37  38  39  40
 *   Lejan Melrose® - Dark
 *   Brown               1   1   1   1
 *                                         4   52.00   208.00
 *   LEJA-RETROB-RO
 *   Ref. 1950
 * Se lee por columnas (posición X): nombre a la izquierda, tallas en medio y
 * pares/precio/importe a la derecha. «Ref. NNNN» cierra cada modelo.
 */
const X_NOMBRE = [80, 180];
const X_TALLAS = [180, 360];
const X_PRECIO = [395, 450];
const DISTANCIA_MAX = 8;
const RE_SKU = /^[A-Z]{3,}-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

const en = (i, [a, b]) => i.x >= a && i.x < b;

/** «Lejan Melrose® - Dark Brown» -> { modelo: 'Melrose', color: 'Dark Brown' } */
function modeloYColor(nombre) {
  const limpio = nombre.replace(/®/g, '').replace(/^Lejan\s+/i, '').replace(/\s+/g, ' ').trim();
  const corte = limpio.lastIndexOf(' - ');
  if (corte < 0) return { modelo: limpio, color: '' };
  return { modelo: limpio.slice(0, corte).replace(/\s+-$/, '').trim(), color: limpio.slice(corte + 3).trim() };
}

export function lineasLejan(lines) {
  const out = [];
  let dentro = false;
  let b = null;
  const nuevo = () => ({ tallas: null, pares: null, nombre: [], precio: null });
  for (const l of lines) {
    if (/^MODELO\b/.test(l.text) && /TALLAS/.test(l.text)) { dentro = true; b = nuevo(); continue; }
    if (!dentro) continue;
    if (/Total pares|LEJAN BRAND SL\. ·/.test(l.text)) { dentro = false; continue; }
    if (/^Pedido\s+\d+\s*[·•]/.test(l.text)) continue;
    const numeros = l.items.filter((i) => en(i, X_TALLAS) && /^\d{1,2}$/.test(i.s.trim()));
    const izquierda = l.items.filter((i) => en(i, X_NOMBRE)).map((i) => i.s.trim()).join(' ').trim();
    const precio = l.items.find((i) => en(i, X_PRECIO) && /^\d+\.\d{2}$/.test(i.s.trim()));
    if (precio) b.precio = parseImporteEn(precio.s.trim());
    if (numeros.length) {
      if (!b.tallas) b.tallas = numeros;
      else if (!b.pares) b.pares = numeros;
    }
    if (!izquierda) continue;
    const ref = izquierda.match(/^Ref\.\s*(\S+)/);
    if (ref) {
      const { modelo, color } = modeloYColor(b.nombre.join(' '));
      for (const p of b.pares ?? []) {
        const talla = (b.tallas ?? []).find((t) => Math.abs(t.x - p.x) <= DISTANCIA_MAX);
        const cantidad = Number(p.s);
        if (!talla || !cantidad) continue;
        out.push({ marca: MARCA, referencia: ref[1], modelo, color, talla: Number(talla.s), cantidad, coste_cent: b.precio, pvp_cent: null });
      }
      b = nuevo();
    } else if (!RE_SKU.test(izquierda)) {
      b.nombre.push(izquierda);
    }
  }
  return out;
}

/** Compara los pares leídos con «Total pares» del PDF. */
function avisoPares(lines, lineas) {
  const total = Number(matchFirst(lines, /Total pares\s+(\d+)/) ?? NaN);
  const leidos = lineas.reduce((s, l) => s + l.cantidad, 0);
  return Number.isFinite(total) && total !== leidos ? [`Se han leído ${leidos} pares y la factura indica ${total}: revisa los productos.`] : [];
}
