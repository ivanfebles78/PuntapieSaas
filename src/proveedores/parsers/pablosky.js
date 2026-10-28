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
import { parseFecha, parseImporteEs, RE_IMPORTE_ES, RE_FECHA_DMY, matchFirst, titulo, unique } from './utils.js';

const CIF = 'B45007671';
const RE_SOLO_IMPORTES = new RegExp(`^(?:${RE_IMPORTE_ES.source})(?:\\s+(?:${RE_IMPORTE_ES.source}))*$`);

export const pablosky = {
  id: 'pablosky',
  nombre: 'Pablosky',
  detect: (text) => text.includes(CIF) || /CALZADOS PABLO S\.L\.U\./i.test(text),
  parse({ lines }) {
    if (esPropuesta(lines)) return parsePropuesta(lines);
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

/* ---------- Propuesta de pedido (con TALLAS y PARES) ----------
 * La factura/proforma solo da cantidades por tramo de tallas («4 × 18-23»); la
 * propuesta de pedido trae, por modelo, una fila TALLAS y debajo otra PARES:
 * cada número de PARES va bajo su talla, así que se emparejan por posición X.
 *   Modelo 064224 Color NOBUCK-TECH MARINO Piso ...
 *   20-23 28,27 PVPR 59,95   24-27 29,72 PVPR 62,95
 *   TALLAS 20 21 22 23 24 25 26 27
 *   PARES   1  1  1  1  1  1  1  1
 */
const MARCA = 'Pablosky';
const X_MIN = 80;
const X_MAX = 430;
const DISTANCIA_MAX = 15;

const tieneCelda = (l, s) => l.items.some((i) => i.s.trim() === s);
export const esPropuesta = (lines) => lines.some((l) => tieneCelda(l, 'PARES')) && lines.some((l) => tieneCelda(l, 'TALLAS'));

// El material va delante del color («NOBUCK-TECH MARINO»): se queda el color.
const COLOR_SIMPLE = { marino: 'Azul Marino', navy: 'Azul Marino', negro: 'Negro', black: 'Negro', blanco: 'Blanco', white: 'Blanco', 'off-white': 'Blanco', beig: 'Beige', beige: 'Beige' };
export function colorSimple(completo) {
  const ultima = String(completo ?? '').trim().split(/\s+/).pop().toLowerCase();
  if (COLOR_SIMPLE[ultima]) return COLOR_SIMPLE[ultima];
  if (/white|blanc/.test(ultima)) return 'Blanco';
  if (/black|negr/.test(ultima)) return 'Negro';
  if (/navy|marin/.test(ultima)) return 'Azul Marino';
  return titulo(ultima || completo);
}

export function lineasPropuesta(lines) {
  const inicios = lines.flatMap((l, i) => (/Modelo\s+\d+/.test(l.text) ? [i] : []));
  const porSku = new Map();
  inicios.forEach((inicio, n) => {
    const bloque = lines.slice(inicio, inicios[n + 1] ?? lines.length);
    const texto = bloque.map((l) => l.text).join(' ');
    const referencia = texto.match(/Modelo\s+(\d+)/)?.[1];
    if (!referencia) return;
    const color = colorSimple(texto.match(/Color\s+(.+?)\s+Piso/)?.[1] ?? '');
    const piso = texto.match(/Piso\s+([A-Za-zÁÉÍÓÚÑ0-9]+)/)?.[1] ?? '';
    const tramos = [...texto.matchAll(/(\d+)-(\d+)\s+(\d+,\d{2})\s+PVPR\s+(\d+,\d{2})/g)]
      .map((m) => ({ desde: Number(m[1]), hasta: Number(m[2]), coste: parseImporteEs(m[3]), pvp: parseImporteEs(m[4]) }));
    const filaTallas = bloque.find((l) => tieneCelda(l, 'TALLAS'));
    const filaPares = bloque.find((l) => tieneCelda(l, 'PARES'));
    if (!filaTallas || !filaPares) return;
    const tallas = filaTallas.items.filter((i) => /^\d{2}$/.test(i.s.trim()) && Number(i.s) >= 17 && Number(i.s) <= 50 && i.x < X_MAX);
    const pares = filaPares.items.filter((i) => /^\d+$/.test(i.s.trim()) && i.x > X_MIN && i.x < X_MAX);
    for (const p of pares) {
      const cerca = tallas.reduce((best, t) => (Math.abs(t.x - p.x) < Math.abs((best?.x ?? Infinity) - p.x) ? t : best), null);
      if (!cerca || Math.abs(cerca.x - p.x) > DISTANCIA_MAX) continue;
      const talla = Number(cerca.s);
      const tramo = tramos.find((t) => talla >= t.desde && talla <= t.hasta);
      const key = `${referencia}|${color}|${talla}`;
      const previa = porSku.get(key);
      porSku.set(key, {
        marca: MARCA, referencia, modelo: titulo(piso) || referencia, color, talla,
        cantidad: (previa?.cantidad ?? 0) + Number(p.s),
        coste_cent: tramo?.coste ?? null, pvp_cent: tramo?.pvp ?? null,
      });
    }
  });
  return [...porSku.values()].sort((a, b) => a.referencia.localeCompare(b.referencia) || a.color.localeCompare(b.color) || a.talla - b.talla);
}

function parsePropuesta(lines) {
  const texts = lines.map((l) => l.text);
  const todo = texts.join('\n');
  const lineas = lineasPropuesta(lines);
  const fianza = parseImporteEs(todo.match(/FIANZA\s*25%\s*(\d{1,3}(?:\.\d{3})*,\d{2})/)?.[1] ?? '');
  const total = fianza != null ? fianza * 4 : lineas.reduce((s, l) => s + (l.coste_cent ?? 0) * l.cantidad, 0);
  const paresPdf = Number(todo.match(/Total Pares:\s*(\d+)/i)?.[1] ?? todo.match(/\bPares:\s*(\d+)/i)?.[1] ?? NaN);
  const leidas = lineas.reduce((s, l) => s + l.cantidad, 0);
  return {
    tipo: 'pedido',
    proveedor: { nombre: 'CALZADOS PABLO S.L.U. (Pablosky)', cif: CIF },
    numero: todo.match(/\b(\d{9,}[A-ZÑ]\d)\b/)?.[1] ?? todo.match(/\b([A-Z]{4,}\d{6,})\b/)?.[1] ?? null,
    fecha: parseFecha(todo.match(RE_FECHA_DMY)?.[0] ?? ''),
    total_cent: total || null,
    vencimientos: [],
    pedidos: [],
    albaranes: [],
    fecha_entrega: null,
    forma_pago: null,
    lineas,
    avisos: Number.isFinite(paresPdf) && paresPdf !== leidas ? [`Se han leído ${leidas} pares y la propuesta indica ${paresPdf}: revisa los productos.`] : [],
  };
}
