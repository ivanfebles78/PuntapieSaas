// Parser genérico por heurísticas para proveedores sin parser propio.
// Siempre devuelve confianza "baja": el usuario debe revisar los datos antes de guardar.
import {
  parseFecha, parseImporteEs, parseImporteEn, RE_IMPORTE_ES, RE_IMPORTE_EN, RE_CIF, RE_FECHA_DMY, RE_FECHA_EN, unique,
} from './utils.js';

const RE_SOCIEDAD = /\b(S\.?\s?L\.?U?\.?|S\.?\s?A\.?U?\.?|S\.?\s?COOP\.?|C\.?B\.?|S\.?L\.?L\.?|LTD|GMBH|SRL|B\.?V\.?)\b/i;
const RE_FECHA_ANY = new RegExp(`${RE_FECHA_DMY.source}|${RE_FECHA_EN.source}`);
const RE_NUMERO_CON_TITULO = /(?:FACTURA|INVOICE|PEDIDO|ORDER|PROFORMA)\b[^\d\n]{0,40}?(?:N[ºo°.]*|No\.?|#|N[uú]m(?:ero)?\.?)?\s*:?\s*([A-Z]?[A-Z0-9][A-Z0-9/\-_.]*\d[A-Z0-9/\-_.]*)/i;
const RE_NUMERO_SUELTO = /(?:N[ºo°]\.?|N[uú]m(?:ero)?\.?|Number|#)\s*:?\s*([A-Z0-9][A-Z0-9/\-_.]*\d[A-Z0-9/\-_.]*)/i;

export const generico = {
  id: 'generico',
  nombre: 'Genérico',
  detect: () => true,
  parse({ lines, text }, ctx = {}) {
    const texts = lines.map((l) => l.text);
    const cabecera = texts.slice(0, 40).join(' ');
    const avisos = ['Proveedor sin parser específico: revisa todos los campos.'];

    let tipo = 'factura';
    if (!/\b(FACTURA|INVOICE)\b/i.test(cabecera) && /\b(PEDIDO|ORDER|PROFORMA|PROPUESTA)\b/i.test(cabecera)) tipo = 'pedido';

    const cifsPropios = (ctx.cifsPropios ?? []).map((c) => c.toUpperCase());
    const proveedor = buscarProveedor(texts, cifsPropios);

    const numero = texts.map((t) => t.match(RE_NUMERO_CON_TITULO)?.[1]).find(Boolean)
      ?? texts.map((t) => t.match(RE_NUMERO_SUELTO)?.[1]).find(Boolean)
      ?? null;

    const usaEn = contar(text, RE_IMPORTE_EN) > contar(text, RE_IMPORTE_ES);
    const parseImporte = usaEn ? parseImporteEn : parseImporteEs;
    const reImporte = new RegExp((usaEn ? RE_IMPORTE_EN : RE_IMPORTE_ES).source, 'g');

    const fecha = primeraFecha(texts.filter((t) => /\b(fecha|date)\b/i.test(t) && !/venc|vto|entrega|delivery|due/i.test(t)))
      ?? primeraFecha(texts);

    const total = buscarTotal(texts, reImporte, parseImporte);

    const vencimientos = [];
    for (const t of texts.filter((x) => /venc|vto\b|vto\.|due date/i.test(x))) {
      const fechas = [...t.matchAll(new RegExp(RE_FECHA_ANY.source, 'g'))].map((m) => parseFecha(m[0])).filter(Boolean);
      const importes = [...t.matchAll(reImporte)].map((m) => parseImporte(m[0]));
      fechas.forEach((f, i) => vencimientos.push({ fecha: f, importe_cent: importes[i] ?? null }));
    }
    const sinImporte = vencimientos.filter((v) => v.importe_cent == null);
    if (sinImporte.length > 0 && total != null) {
      const reparto = Math.round(total / sinImporte.length);
      sinImporte.forEach((v, i) => {
        v.importe_cent = i === sinImporte.length - 1 ? total - reparto * (sinImporte.length - 1) : reparto;
      });
      if (sinImporte.length > 1) avisos.push('Los vencimientos no indicaban importe: se ha repartido el total a partes iguales.');
    }
    const vencimientosValidos = tipo === 'factura' ? vencimientos.filter((v) => v.importe_cent != null) : [];

    const fechaEntrega = primeraFecha(texts.filter((t) => /entrega|delivery/i.test(t)));
    const formaPago = texts.map((t) => t.match(/(?:forma de pago|forma pago|payment(?: terms)?)\s*:?\s*(.+)$/i)?.[1]).find(Boolean)?.trim() ?? null;

    return {
      tipo,
      proveedor,
      numero,
      fecha,
      total_cent: total,
      vencimientos: vencimientosValidos,
      pedidos: unique(texts.map((t) => t.match(/\b(?:pedido|order)\s*(?:n[ºo°.]*)?\s*:?\s*([A-Z0-9][A-Z0-9/\-]*\d[A-Z0-9/\-]*)/i)?.[1]).filter(Boolean)),
      albaranes: unique(texts.map((t) => t.match(/\balbar[áa]n\s*(?:n[ºo°.]*)?\s*:?\s*([A-Z0-9][A-Z0-9/\-]*\d[A-Z0-9/\-]*)/i)?.[1]).filter(Boolean)),
      fecha_entrega: fechaEntrega,
      forma_pago: formaPago,
      confianza: 'baja',
      avisos,
    };
  },
};

function contar(text, re) {
  return (text.match(new RegExp(re.source, 'g')) ?? []).length;
}

function primeraFecha(texts) {
  for (const t of texts) {
    const f = parseFecha(t);
    if (f) return f;
  }
  return null;
}

function buscarProveedor(texts, cifsPropios) {
  const reCif = new RegExp(RE_CIF.source, 'g');
  for (let i = 0; i < texts.length; i += 1) {
    for (const m of texts[i].matchAll(reCif)) {
      const cif = m[1].toUpperCase();
      if (cifsPropios.includes(cif)) continue;
      const resto = texts[i].replace(m[0], '').replace(/\b(C\.?I\.?F\.?|N\.?I\.?F\.?|VAT|ES)\b\s*:?/gi, '').trim();
      const nombre = resto.replace(/[^\p{L}]/gu, '').length >= 3 ? resto
        : nombreSociedad(texts.slice(Math.max(0, i - 3), i).reverse()) ?? nombreSociedad(texts.slice(0, 15)) ?? texts[0] ?? null;
      return { nombre, cif };
    }
  }
  return { nombre: nombreSociedad(texts.slice(0, 15)) ?? texts[0] ?? null, cif: null };
}

function nombreSociedad(texts) {
  return texts.find((t) => RE_SOCIEDAD.test(t) && !/factura|invoice|pedido|cif|nif/i.test(t)) ?? null;
}

function buscarTotal(texts, reImporte, parseImporte) {
  const candidatos = texts
    .filter((t) => /\btotal\b/i.test(t) && !/pares|unidades|bultos|peso|qty|cantidad|bruto|base|subtotal|iva\s*\(/i.test(t))
    .flatMap((t) => [...t.matchAll(reImporte)].map((m) => parseImporte(m[0])))
    .filter((v) => v != null && v > 0);
  if (candidatos.length > 0) return Math.max(...candidatos);
  const todos = texts.flatMap((t) => [...t.matchAll(reImporte)].map((m) => parseImporte(m[0]))).filter((v) => v != null);
  return todos.length > 0 ? Math.max(...todos) : null;
}
