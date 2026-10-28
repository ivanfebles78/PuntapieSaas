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
import { matchFirst, matchAll, parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, titulo, unique } from './utils.js';

const CIF = 'B03503034';
const NOMBRE = 'GIOSEPPO, S.L.U';
const RE_IMPORTES_G = new RegExp(RE_IMPORTE_ES.source, 'g');
const RE_FECHAS_G = new RegExp(RE_FECHA_DMY.source, 'g');
const MARCA = 'Gioseppo';

// Pedido: «Nota Cajas Pares Ref.-Nombre Color Tallas: composición = N Pares F.Servicio Precio [Dto.] Neto P.V.P.»
//   13 1 9 78547-MORLEY Marino 21-27: 1, 1, 1, 2, 2, 1, 1 = 9 Pares 15/03/2027 16,65 € 149,85 € 39,95 €
// La composición es de UNA caja: las unidades por talla = composición × (Pares ÷ suma de la composición).
const RE_LINEA_PEDIDO = /^\d+\s+(?:-|\d+)\s+(\d+)\s+(\d+)-(\S+)\s+(.+?)\s+(\d{1,2})-(\d{1,2}):\s*([\d,\s]+?)\s*=\s*\d+\s+Pares\s+\d{2}\/\d{2}\/\d{4}\s+(.+)$/;
// Factura: «Ref. Nombre Color Familia Género Partida Talla Unids. Precio Importe», una línea por talla.
//   80514-P 80514 Azul CAS&SPORT BABY BOY 6402999100 21 1 16,65 16,65
const RE_LINEA_FACTURA = /^(\S+)\s+(\S+)\s+(.+?)\s+\d{8,10}\s+(\d{1,2})\s+(\d+)\s+(\d+,\d{2})\s+[\d.]+,\d{2}$/;

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
    lineas: lineasFactura(texts),
    avisos: [],
  };
}

/** El color son las palabras en minúscula/capitalizadas que van antes de la familia (en mayúsculas). */
function colorDe(resto) {
  const palabras = resto.split(/\s+/);
  const color = [];
  for (const p of palabras) {
    if (color.length && p === p.toUpperCase()) break;
    color.push(p);
  }
  return titulo(color.join(' '));
}

export function lineasFactura(texts) {
  return texts.flatMap((t) => {
    const m = t.match(RE_LINEA_FACTURA);
    if (!m) return [];
    const [, ref, nombre, resto, talla, unidades, precio] = m;
    return [{
      marca: MARCA,
      referencia: ref.split('-')[0],
      modelo: titulo(nombre),
      color: colorDe(resto),
      talla: Number(talla),
      cantidad: Number(unidades),
      coste_cent: parseImporteEs(precio),
      pvp_cent: null,
    }];
  });
}

export function lineasPedido(texts) {
  return texts.flatMap((t) => {
    const m = t.match(RE_LINEA_PEDIDO);
    if (!m) return [];
    const [, pares, referencia, nombre, color, desde, hasta, composicion, precios] = m;
    const unidades = composicion.split(',').map((x) => Number(x.trim()) || 0);
    const porCaja = unidades.reduce((a, b) => a + b, 0);
    const cajas = porCaja ? Number(pares) / porCaja : 1;
    const importes = [...precios.matchAll(RE_IMPORTES_G)].map((x) => parseImporteEs(x[0]));
    const coste = importes[0] ?? null;
    const pvp = importes.length >= 3 ? importes[importes.length - 1] : null;
    return unidades.flatMap((u, i) => {
      const talla = Number(desde) + i;
      if (!u || talla > Number(hasta)) return [];
      return [{
        marca: MARCA, referencia, modelo: titulo(nombre), color: titulo(color), talla,
        cantidad: Math.round(u * cajas), coste_cent: coste, pvp_cent: pvp,
      }];
    });
  });
}

// Expositores y material de punto de venta: van a 0,00 € y no son stock.
const RE_LINEA_PLV = /^\d+\s+(?:-|\d+)\s+(\d+)\s+.*\s0,00 €\s+0,00 €\s+0,00 €$/;

/** Compara las unidades leídas con «TOTAL (Prs+Uds)» del PDF (sin contar los expositores). */
function avisoUnidades(texts, lineas) {
  const total = Number(texts.map((t) => t.match(/TOTAL \(Prs\+Uds\):\s*(\d+)/)?.[1]).find(Boolean));
  if (!total) return [];
  const plv = texts.reduce((s, t) => s + Number(t.match(RE_LINEA_PLV)?.[1] ?? 0), 0);
  const leidas = lineas.reduce((s, l) => s + l.cantidad, 0);
  return leidas === total - plv ? [] : [`Se han leído ${leidas} unidades y el pedido indica ${total - plv}: revisa los productos.`];
}

function parsePedido(texts) {
  const lineas = lineasPedido(texts);
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
    lineas,
    avisos: avisoUnidades(texts, lineas),
  };
}
