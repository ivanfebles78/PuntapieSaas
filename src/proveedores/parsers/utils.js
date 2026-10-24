// Utilidades compartidas por los parsers: dinero en céntimos, fechas ISO y
// búsqueda de líneas. Todo son funciones puras para poder portarlas tal cual.

const MESES_EN = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MESES_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export const RE_IMPORTE_ES = /-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}/;
export const RE_IMPORTE_EN = /-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2}/;
export const RE_FECHA_DMY = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;
export const RE_FECHA_EN = /\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/;
export const RE_CIF = /\b(?:ES)?([ABCDEFGHJKLMNPQRSUVW]\d{8}|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/;

/** "1.271,84" -> 127184 (céntimos). Devuelve null si no es un importe. */
export function parseImporteEs(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(new RegExp(`^(?:${RE_IMPORTE_ES.source})$`));
  if (!m) return null;
  const normalizado = m[0].replace(/\./g, '').replace(',', '.');
  return Math.round(Number(normalizado) * 100);
}

/** "1,845.00" -> 184500 (céntimos). Devuelve null si no es un importe. */
export function parseImporteEn(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(new RegExp(`^(?:${RE_IMPORTE_EN.source})$`));
  if (!m) return null;
  return Math.round(Number(m[0].replace(/,/g, '')) * 100);
}

/** Convierte a ISO "YYYY-MM-DD" fechas dd/mm/yyyy, dd/mm/yy o "September 30, 2026". */
export function parseFecha(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  let m = s.match(RE_FECHA_DMY);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return toIso(year, Number(mo), Number(d));
  }
  m = s.match(RE_FECHA_EN);
  if (m) {
    const month = MESES_EN[m[1].toLowerCase()] ?? MESES_ES[m[1].toLowerCase()];
    if (month) return toIso(Number(m[3]), month, Number(m[2]));
  }
  m = s.match(/\b(\d{1,2})\s+de\s+([a-záé]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const month = MESES_ES[m[2].toLowerCase()];
    if (month) return toIso(Number(m[3]), month, Number(m[1]));
  }
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function toIso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Devuelve la primera línea cuyo texto cumple el patrón. */
export function findLine(lines, re) {
  return lines.find((l) => re.test(l.text)) ?? null;
}

/** Devuelve el primer grupo capturado del patrón buscando en todas las líneas. */
export function matchFirst(lines, re, group = 1) {
  for (const l of lines) {
    const m = l.text.match(re);
    if (m) return m[group] ?? null;
  }
  return null;
}

/** Devuelve todos los grupos capturados (sin duplicados) en todas las líneas. */
export function matchAll(lines, re, group = 1) {
  const out = [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  for (const l of lines) {
    for (const m of l.text.matchAll(global)) {
      const v = m[group];
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

export function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}
