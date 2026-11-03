// Tipos de producto y sus tallas. Cada tipo dice qué clases de talla admite
// (un zapato va por número; un pijama por letra o edad) y si el color es
// obligatorio. La talla se guarda como texto normalizado («27», «38,5», «M»,
// «4A», «19-22», «Única») junto con un orden numérico para listarlas bien.

export const TIPOS = Object.freeze({
  calzado: Object.freeze({ nombre: 'Calzado', tallas: Object.freeze(['numero']), color: true }),
  ropa: Object.freeze({ nombre: 'Ropa', tallas: Object.freeze(['letra', 'edad', 'rango', 'ropa', 'unica']), color: true }),
  accesorios: Object.freeze({ nombre: 'Accesorios', tallas: Object.freeze(['unica', 'letra']), color: true }),
  juguetes: Object.freeze({ nombre: 'Juguetes', tallas: Object.freeze(['unica']), color: false }),
});

export const CLASES_TALLA = Object.freeze({
  numero: 'número de pie (27, 38,5)',
  letra: 'letra (XS, S, M, L, XL)',
  edad: 'edad (18M, 4A)',
  rango: 'rango (19-22)',
  ropa: 'número de ropa (2, 4, 6…)',
  unica: 'talla única',
});

export const TALLA_UNICA = 'Única';
const LETRAS = Object.freeze(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
const ALIAS_LETRA = Object.freeze({ '2XL': 'XXL', '3XL': 'XXXL', '2XS': 'XXS' });
const UNICAS = new Set(['', '0', 'U', 'UNICA', 'ÚNICA', 'TU', 'T.U.', 'T.U', 'TALLA UNICA', 'TALLA ÚNICA']);

// Cada clase reconoce su forma de escribir la talla y da su texto y su orden.
const LECTORES = Object.freeze({
  unica: (raw) => (UNICAS.has(raw) ? { talla: TALLA_UNICA, orden: 1000 } : null),
  numero: (raw) => {
    const m = raw.match(/^(\d{1,2})(?:[.,](5|50))?$/);
    const n = m ? Number(m[1]) + (m[2] ? 0.5 : 0) : NaN;
    return n >= 14 && n <= 50 ? { talla: m[2] ? `${m[1]},5` : m[1], orden: n } : null;
  },
  ropa: (raw) => (/^\d{1,2}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 16 ? { talla: String(Number(raw)), orden: 400 + Number(raw) } : null),
  letra: (raw) => {
    const letra = ALIAS_LETRA[raw] ?? raw;
    return LETRAS.includes(letra) ? { talla: letra, orden: 100 + LETRAS.indexOf(letra) } : null;
  },
  edad: (raw) => {
    const anos = raw.match(/^(\d{1,2}) ?(A|AÑOS?|ANOS?|Y)$/);
    if (anos && Number(anos[1]) >= 1 && Number(anos[1]) <= 16) return { talla: `${Number(anos[1])}A`, orden: 200 + Number(anos[1]) * 12 };
    const meses = raw.match(/^(\d{1,2}) ?(M|MESES)$/);
    return meses && Number(meses[1]) <= 36 ? { talla: `${Number(meses[1])}M`, orden: 200 + Number(meses[1]) } : null;
  },
  rango: (raw) => {
    const m = raw.match(/^(\d{1,2}) ?[-/] ?(\d{1,2})$/);
    return m && Number(m[1]) < Number(m[2]) ? { talla: `${Number(m[1])}-${Number(m[2])}`, orden: 300 + Number(m[1]) } : null;
  },
});

const ORDEN_GENERAL = Object.freeze(['unica', 'numero', 'letra', 'edad', 'rango', 'ropa']);
const normal = (valor) => String(valor ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export const esTipo = (tipo) => Object.hasOwn(TIPOS, tipo);

function leerCon(clases, valor) {
  const raw = normal(valor);
  for (const clase of clases) {
    const t = LECTORES[clase](raw);
    if (t) return { ...t, clase };
  }
  return null;
}

/** Reconoce una talla sin saber el tipo (la primera clase que encaja). */
export const leerTalla = (valor) => leerCon(ORDEN_GENERAL, valor);

/** Talla válida para ese tipo, o un mensaje que explica qué tallas admite. */
export function tallaParaTipo(valor, tipo) {
  const admitidas = TIPOS[tipo].tallas;
  const t = leerCon(admitidas, valor);
  if (t) return { ok: true, ...t };
  return { ok: false, error: `talla «${String(valor ?? '').trim() || 'vacía'}» no válida para ${TIPOS[tipo].nombre.toLowerCase()}: usa ${admitidas.map((c) => CLASES_TALLA[c]).join(', ')}` };
}

/** Tipo de una línea que no lo indica: con número de pie es calzado; si no, accesorio (se corrige en Inventario). */
export function tipoPorDefecto(talla) {
  return leerTalla(talla)?.clase === 'numero' ? 'calzado' : 'accesorios';
}
