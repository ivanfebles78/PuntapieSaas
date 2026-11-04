// Propuesta de tipo y subtipo para las líneas leídas de un pedido o factura.
// Por orden de confianza:
//   1. «stock»: la misma marca y referencia ya está en el inventario → lo que se
//      eligió entonces (así lo que se corrige una vez se recuerda).
//   2. «palabra»: la descripción lo dice (MOCHILA, PIJAMA, PARCHÍS…).
//   3. «lector»: el lector del proveedor lo sabe (Cóndor = ropa).
//   4. «marca»: lo más habitual de esa marca en el inventario.
//   5. «talla»: con número de pie, calzado; si no, accesorio.
import { CLASES_TALLA, leerTalla, TIPOS, tallaParaTipo, tipoPorDefecto } from './tipos.js';

// Lectores de proveedores que solo venden calzado: sus líneas con número de pie son zapatos.
const LECTORES_CALZADO = new Set(['garvalin', 'gioseppo', 'lejan', 'pablosky', 'titanitos', 'etika', 'victoria', 'vulladi']);

// Palabra entera (las tildes y la ñ cuentan como letra, que `\b` no lo hace).
const palabra = (alternativas) => new RegExp(`(?<![A-ZÁÉÍÓÚÜÑ0-9])(?:${alternativas})(?![A-ZÁÉÍÓÚÜÑ])`);

const PALABRAS = Object.freeze([
  [palabra('MOCHILAS?|MOCH'), 'accesorios', 'Mochilas'],
  [palabra('PARAGUAS'), 'accesorios', 'Paraguas'],
  [palabra('BOTELLAS?|BOT\\.|BO\\.|BO \\d|TERMO|CANTIMPLORA|BN \\d'), 'accesorios', 'Botellas'],
  [palabra('ESTUCHES?|PORTATODO|PTDO|PORTAORDEN'), 'accesorios', 'Estuches'],
  [palabra('CALCETÍN|CALCETIN|CALCETINES|LEOTARDOS?|PANTYS?|MEDIAS|PINKIES'), 'ropa', 'Calcetines'],
  [palabra('PIJAMAS?'), 'ropa', 'Pijamas'],
  [palabra('CHUBASQUEROS?|IMPERMEABLES?'), 'ropa', 'Chubasqueros'],
  [palabra('BAÑADOR(ES)?|BANADOR(ES)?|BIKINIS?'), 'ropa', 'Bañadores'],
  [palabra('YOYÓS?|YOYOS?'), 'juguetes', 'Yoyós'],
  [palabra('CARTAS|BARAJAS?|NAIPES'), 'juguetes', 'Juegos de cartas'],
  [palabra('JUEGOS?|PARCHÍS|PARCHIS|PUZZLES?|DOMINÓ|DOMINO|TIC TAC|FORMAPALABRAS|JUG\\.'), 'juguetes', 'Juegos de mesa'],
  [palabra('SANDALIAS?|CHANCLAS?'), 'calzado', 'Sandalias'],
  [palabra('BOTAS?|BOTÍN|BOTIN|BOTINES|KATIUSKAS?'), 'calzado', 'Botas'],
  [palabra('ESCOLAR(ES)?|COLEGIAL|MERCEDITAS?'), 'calzado', 'Escolares'],
  [palabra('DEPORTIVAS?|ZAPATILLAS?|SNEAKERS?|TENIS|RUNNING'), 'calzado', 'Tenis'],
]);

/** Tipo y subtipo (por nombre) que dice la descripción, o null. */
export function tipoPorPalabras(texto) {
  const t = String(texto ?? '').toUpperCase();
  // Solo los tipos que siguen en el catálogo (se pueden borrar en Admin › Catálogo).
  const hit = PALABRAS.find(([re, tipo]) => Object.hasOwn(TIPOS, tipo) && re.test(t));
  return hit ? { tipo: hit[1], subtipo: hit[2] } : null;
}

/** Catálogo para el navegador: tipos con sus tallas y subtipos. */
export async function catalogoTipos(db) {
  const subtipos = (await db.query('SELECT id, type, name FROM product_subtypes ORDER BY type, name')).rows;
  return Object.entries(TIPOS).map(([id, t]) => ({
    id,
    nombre: t.nombre,
    color: t.color,
    tallas: t.tallas.map((c) => CLASES_TALLA[c]),
    subtipos: subtipos.filter((s) => s.type === id).map((s) => ({ id: s.id, tipo: s.type, nombre: s.name })),
  }));
}

/**
 * Añade a cada línea `tipo`, `subtipo_id` y `propuesta` (de dónde sale).
 * No cambia nada más; si la talla no vale para el tipo propuesto, lo avisa en `aviso_tipo`.
 */
export async function proponerTipos(db, lineas, { marca: marcaDefecto = '', parser = null } = {}) {
  if (!lineas?.length) return lineas ?? [];
  const catalogo = await catalogoTipos(db);
  const subtipoId = (tipo, nombre) => catalogo.find((t) => t.id === tipo)?.subtipos.find((s) => s.nombre === nombre)?.id ?? null;
  const marcas = [...new Set(lineas.map((l) => String(l.marca || marcaDefecto).trim().toLowerCase()).filter(Boolean))];
  const enStock = marcas.length ? (await db.query(
    `SELECT lower(brand) AS marca, lower(reference) AS ref, type, subtype_id FROM inventory_items
      WHERE lower(brand) = ANY($1) ORDER BY updated_at DESC`, [marcas])).rows : [];
  const porRef = new Map();
  const cuentaMarca = new Map();
  for (const r of enStock) {
    if (!porRef.has(`${r.marca}|${r.ref}`)) porRef.set(`${r.marca}|${r.ref}`, r);
    const c = cuentaMarca.get(r.marca) ?? {};
    c[r.type] = (c[r.type] ?? 0) + 1;
    cuentaMarca.set(r.marca, c);
  }
  const habitual = (marca) => Object.entries(cuentaMarca.get(marca) ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return lineas.map((l) => {
    const marca = String(l.marca || marcaDefecto).trim().toLowerCase();
    const previo = porRef.get(`${marca}|${String(l.referencia ?? '').trim().toLowerCase()}`);
    const palabra = tipoPorPalabras(`${l.modelo ?? ''} ${l.detalle ?? ''}`);
    const lector = l.tipo && Object.hasOwn(TIPOS, l.tipo) ? l.tipo
      : Object.hasOwn(TIPOS, 'calzado') && LECTORES_CALZADO.has(parser) && leerTalla(l.talla)?.clase === 'numero' ? 'calzado' : null;
    let r;
    if (previo) r = { tipo: previo.type, subtipo_id: previo.subtype_id, propuesta: 'stock' };
    else if (palabra) r = { tipo: palabra.tipo, subtipo_id: subtipoId(palabra.tipo, palabra.subtipo), propuesta: 'palabra' };
    else if (lector) r = { tipo: lector, subtipo_id: null, propuesta: 'lector' };
    else if (habitual(marca)) r = { tipo: habitual(marca), subtipo_id: null, propuesta: 'marca' };
    else r = { tipo: tipoPorDefecto(l.talla), subtipo_id: null, propuesta: 'talla' };
    // El subtipo de una palabra sirve aunque el tipo venga de otra fuente, si coincide.
    if (r.subtipo_id == null && palabra?.tipo === r.tipo) r.subtipo_id = subtipoId(palabra.tipo, palabra.subtipo);
    const talla = tallaParaTipo(l.talla, r.tipo);
    return { ...l, ...r, ...(talla.ok ? {} : { aviso_tipo: talla.error }) };
  });
}
