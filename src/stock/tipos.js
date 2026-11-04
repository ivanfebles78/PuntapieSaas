// Tipos de producto y sus tallas. Cada tipo dice qué clases de talla admite
// (un zapato va por número; un pijama por letra o edad) y si el color es
// obligatorio. La talla se guarda como texto normalizado («27», «38,5», «M»,
// «4A», «19-22», «Única») junto con un orden numérico para listarlas bien.
//
// Los tipos se editan en Admin › Catálogo (tabla product_types): aquí se
// guarda una copia en memoria que `cargarTipos` refresca al arrancar y después
// de cada cambio. Hasta entonces valen los cuatro de siempre.

const congelar = (t) => Object.freeze({ nombre: t.nombre, tallas: Object.freeze([...t.tallas]), color: Boolean(t.color) });

const INICIALES = Object.freeze({
  calzado: congelar({ nombre: 'Calzado', tallas: ['numero'], color: true }),
  ropa: congelar({ nombre: 'Ropa', tallas: ['letra', 'edad', 'rango', 'ropa', 'unica'], color: true }),
  accesorios: congelar({ nombre: 'Accesorios', tallas: ['unica', 'letra'], color: true }),
  juguetes: congelar({ nombre: 'Juguetes', tallas: ['unica'], color: false }),
});

// eslint-disable-next-line import/no-mutable-exports -- se sustituye entero (nunca se modifica) al recargar
export let TIPOS = INICIALES;

/** Lee los tipos de la base de datos (en su orden) y sustituye la copia en memoria. */
export async function cargarTipos(db) {
  const rows = (await db.query('SELECT key, name, size_classes, color_required FROM product_types ORDER BY position, name')).rows;
  if (!rows.length) return TIPOS;
  TIPOS = Object.freeze(Object.fromEntries(rows.map((r) => [r.key, congelar({ nombre: r.name, tallas: r.size_classes, color: r.color_required })])));
  return TIPOS;
}

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
  if (!esTipo(tipo)) return { ok: false, error: 'tipo de producto no válido' };
  const admitidas = TIPOS[tipo].tallas;
  const t = leerCon(admitidas, valor);
  if (t) return { ok: true, ...t };
  return { ok: false, error: `talla «${String(valor ?? '').trim() || 'vacía'}» no válida para ${TIPOS[tipo].nombre.toLowerCase()}: usa ${admitidas.map((c) => CLASES_TALLA[c]).join(', ')}` };
}

/** Lee una talla con unas clases concretas (para comprobar un cambio de tipo antes de guardarlo). */
export const leerTallaCon = (clases, valor) => leerCon(clases, valor);

/**
 * Tipo de una línea que no lo indica: con número de pie, calzado; si no,
 * accesorios (se corrige en Inventario). Si esos tipos ya no existen, el
 * primero cuyas tallas admitan esa talla.
 */
export function tipoPorDefecto(talla) {
  const preferido = leerTalla(talla)?.clase === 'numero' ? 'calzado' : 'accesorios';
  if (esTipo(preferido)) return preferido;
  const ids = Object.keys(TIPOS);
  return ids.find((id) => leerCon(TIPOS[id].tallas, talla)) ?? ids[0];
}
