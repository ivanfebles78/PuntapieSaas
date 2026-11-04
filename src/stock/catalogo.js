// Admin › Catálogo: tipos de producto (con sus tallas), subtipos y
// fabricantes. Cada fabricante dice para qué tipos y subtipos se ofrece al
// dar de alta un producto. Lo que ya está en el inventario manda: no se borra
// nada que tenga productos y un cambio que dejaría tallas o colores inválidos
// se rechaza explicando cuántos productos lo impiden.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { CLASES_TALLA, TIPOS, cargarTipos, leerTallaCon } from './tipos.js';

const MAX_NOMBRE_TIPO = 40;
const MAX_NOMBRE = 50;
const MAX_ID = 2_147_483_647;
const MAX_AMBITOS = 200;
const MAX_CLAVE = 30;
const LOCK = "hashtext('puntapie:stock:catalogo')";

const invalido = (msg) => new HttpError(400, msg, 'INVALID_CATALOG');
const conflicto = (msg, code = 'IN_USE') => new HttpError(409, msg, code);
const noExiste = (que) => new HttpError(404, `${que} no existe.`, 'NOT_FOUND');
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const productos = (n) => plural(n, 'producto', 'productos');

function nombre(valor, max, que) {
  const t = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!t) throw invalido(`Escribe el nombre del ${que}.`);
  if (t.length > max) throw invalido(`El nombre del ${que} es demasiado largo (máximo ${max} caracteres).`);
  return t;
}

const idValido = (v) => Number.isInteger(v) && v > 0 && v <= MAX_ID;
function leerId(v, que) {
  const id = Number(v);
  if (!idValido(id)) throw noExiste(que);
  return id;
}

/** Clave fija de un tipo nuevo: su nombre en minúsculas, sin tildes ni espacios. */
function clave(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_CLAVE - 3) || 'tipo';
}

function clasesTalla(valor) {
  const lista = Array.isArray(valor) ? [...new Set(valor.map(String))] : [];
  if (!lista.length) throw invalido('Elige al menos una clase de talla.');
  const malas = lista.filter((c) => !Object.hasOwn(CLASES_TALLA, c));
  if (malas.length) throw invalido(`Clase de talla no válida: ${malas.join(', ')}.`);
  // En el orden en que se reconocen (la talla única primero, como hasta ahora).
  return Object.keys(CLASES_TALLA).filter((c) => lista.includes(c)).sort((a, b) => (a === 'unica' ? -1 : b === 'unica' ? 1 : 0));
}

const repetido = (e) => e?.code === '23505';
const enUsoAhora = (e) => e?.code === '23503';
const CAMBIADO = 'Algo del catálogo ha cambiado mientras tanto (otra persona o un alta a la vez). Recarga e inténtalo de nuevo.';

/** Envuelve un cambio del catálogo: los fallos de clave ajena por cambios simultáneos se explican. */
async function sinCarreras(fn) {
  try {
    return await fn();
  } catch (e) {
    if (enUsoAhora(e)) throw conflicto(CAMBIADO, 'CHANGED_MEANWHILE');
    throw e;
  }
}
const bloquear = (db) => db.query(`SELECT pg_advisory_xact_lock(${LOCK})`);

/* ---------- Lectura ---------- */

/** Todo el catálogo, con cuántos productos del inventario usa cada cosa. */
export async function leerCatalogo(db) {
  const [tipos, subtipos, marcas, ambitos, proveedores] = await Promise.all([
    db.query(`SELECT t.key, t.name, t.size_classes, t.color_required,
                     (SELECT count(*)::int FROM inventory_items i WHERE i.type = t.key) AS n
                FROM product_types t ORDER BY t.position, t.name`),
    db.query(`SELECT s.id, s.type, s.name, (SELECT count(*)::int FROM inventory_items i WHERE i.subtype_id = s.id) AS n
                FROM product_subtypes s ORDER BY s.type, s.name`),
    db.query(`SELECT b.id, b.name, b.supplier_id, (SELECT count(*)::int FROM inventory_items i WHERE lower(i.brand) = lower(b.name)) AS n
                FROM product_brands b ORDER BY lower(b.name)`),
    db.query('SELECT brand_id, type, subtype_id FROM product_brand_scopes ORDER BY brand_id, type, subtype_id NULLS FIRST'),
    db.query('SELECT id, name, cif, notes, direct_debit FROM suppliers ORDER BY lower(name), id'),
  ]);
  const nombreProveedor = new Map(proveedores.rows.map((p) => [p.id, p.name]));
  return {
    clases: Object.entries(CLASES_TALLA).map(([id, texto]) => ({ id, texto })),
    tipos: tipos.rows.map((t) => ({
      id: t.key, nombre: t.name, tallas: t.size_classes, color: t.color_required, productos: t.n,
      subtipos: subtipos.rows.filter((s) => s.type === t.key).map((s) => ({ id: s.id, nombre: s.name, productos: s.n })),
    })),
    marcas: marcas.rows.map((b) => ({
      id: b.id, nombre: b.name, productos: b.n,
      proveedor: b.supplier_id ? { id: b.supplier_id, nombre: nombreProveedor.get(b.supplier_id) ?? '' } : null,
      ambitos: ambitos.rows.filter((a) => a.brand_id === b.id).map((a) => ({ tipo: a.type, subtipo_id: a.subtype_id })),
    })),
    proveedores: proveedores.rows.map((p) => ({ id: p.id, nombre: p.name, cif: p.cif, notas: p.notes, domiciliado: p.direct_debit })),
  };
}

/** Fabricantes para el formulario de alta: nombre y ámbitos (vacío = todos los tipos). */
export async function listarMarcas(db) {
  const [marcas, ambitos] = await Promise.all([
    db.query('SELECT id, name FROM product_brands ORDER BY lower(name)'),
    db.query('SELECT brand_id, type, subtype_id FROM product_brand_scopes ORDER BY brand_id, type, subtype_id NULLS FIRST'),
  ]);
  return marcas.rows.map((b) => ({
    id: b.id, nombre: b.name,
    ambitos: ambitos.rows.filter((a) => a.brand_id === b.id).map((a) => ({ tipo: a.type, subtipo_id: a.subtype_id })),
  }));
}

/* ---------- Tipos ---------- */

function datosTipo(body) {
  return { nombre: nombre(body?.nombre, MAX_NOMBRE_TIPO, 'tipo'), tallas: clasesTalla(body?.tallas), color: body?.color !== false };
}

export async function crearTipo(pool, body) {
  const d = datosTipo(body);
  const r = await withTransaction(pool, async (db) => {
    await bloquear(db);
    const base = clave(d.nombre);
    const usadas = new Set((await db.query('SELECT key FROM product_types')).rows.map((x) => x.key));
    let key = base;
    for (let i = 2; usadas.has(key); i += 1) key = `${base}-${i}`;
    try {
      await db.query(`INSERT INTO product_types (key, name, size_classes, color_required, position)
                      VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM product_types))`, [key, d.nombre, d.tallas, d.color]);
    } catch (e) {
      if (repetido(e)) throw conflicto(`Ya hay un tipo «${d.nombre}».`, 'DUPLICATE');
      throw e;
    }
    return { id: key, ...d };
  });
  await cargarTipos(pool);
  return r;
}

/** Comprueba que las tallas (y el color) de los productos de ese tipo siguen valiendo; devuelve el orden nuevo de cada talla. */
async function comprobarProductosTipo(db, key, d) {
  const tallas = (await db.query('SELECT size, count(*)::int AS n FROM inventory_items WHERE type = $1 GROUP BY size', [key])).rows;
  const malas = tallas.filter((t) => !leerTallaCon(d.tallas, t.size));
  if (malas.length) {
    const n = malas.reduce((s, t) => s + t.n, 0);
    const ejemplos = malas.slice(0, 5).map((t) => t.size).join(', ');
    throw conflicto(`Con esas tallas no valdrían ${productos(n)} que ya hay (tallas ${ejemplos}). Cámbiales el tipo en Inventario o elige también esas clases de talla.`, 'SIZES_IN_USE');
  }
  if (d.color) {
    const sinColor = (await db.query("SELECT count(*)::int AS n FROM inventory_items WHERE type = $1 AND color = ''", [key])).rows[0].n;
    if (sinColor) throw conflicto(`Hay ${productos(sinColor)} de este tipo sin color: pónselo en Inventario antes de hacerlo obligatorio.`, 'COLOR_MISSING');
  }
  return tallas.map((t) => ({ talla: t.size, ...leerTallaCon(d.tallas, t.size) }));
}

export async function editarTipo(pool, key, body) {
  const d = datosTipo(body);
  const r = await withTransaction(pool, async (db) => {
    await bloquear(db);
    const antes = (await db.query('SELECT key, name, size_classes, color_required FROM product_types WHERE key = $1', [key])).rows[0];
    if (!antes) throw noExiste('Ese tipo');
    const tallas = await comprobarProductosTipo(db, key, d);
    try {
      await db.query('UPDATE product_types SET name = $2, size_classes = $3, color_required = $4 WHERE key = $1', [key, d.nombre, d.tallas, d.color]);
    } catch (e) {
      if (repetido(e)) throw conflicto(`Ya hay un tipo «${d.nombre}».`, 'DUPLICATE');
      throw e;
    }
    // Una talla puede leerse con otra clase (y otro orden) con las clases nuevas.
    for (const t of tallas) {
      await db.query('UPDATE inventory_items SET size_order = $3 WHERE type = $1 AND size = $2 AND size_order <> $3', [key, t.talla, t.orden]);
    }
    return { antes: { id: key, nombre: antes.name, tallas: antes.size_classes, color: antes.color_required }, despues: { id: key, ...d } };
  });
  await cargarTipos(pool);
  return r;
}

export async function borrarTipo(pool, key) {
  const r = await sinCarreras(() => withTransaction(pool, async (db) => {
    await bloquear(db);
    const t = (await db.query('SELECT key, name FROM product_types WHERE key = $1', [key])).rows[0];
    if (!t) throw noExiste('Ese tipo');
    const n = (await db.query('SELECT count(*)::int AS n FROM inventory_items WHERE type = $1', [key])).rows[0].n;
    if (n) throw conflicto(`No se puede borrar «${t.name}»: hay ${productos(n)} de este tipo en el inventario. Cámbiales el tipo en Inventario primero.`);
    const quedan = (await db.query('SELECT count(*)::int AS n FROM product_types')).rows[0].n;
    if (quedan <= 1) throw conflicto('Tiene que quedar al menos un tipo de producto.', 'LAST_TYPE');
    // Los subtipos y los ámbitos de fabricante de este tipo se van con él.
    await db.query('DELETE FROM product_types WHERE key = $1', [key]);
    return { id: key, nombre: t.name };
  }));
  await cargarTipos(pool);
  return r;
}

/* ---------- Subtipos ---------- */

async function subtipoRepetido(db, tipo, n, excluir = 0) {
  const r = await db.query('SELECT 1 FROM product_subtypes WHERE type = $1 AND lower(name) = lower($2) AND id <> $3', [tipo, n, excluir]);
  if (r.rowCount) throw conflicto(`Ya hay un subtipo «${n}» en ${TIPOS[tipo]?.nombre.toLowerCase() ?? tipo}.`, 'DUPLICATE');
}

export async function crearSubtipo(pool, body) {
  const tipo = String(body?.tipo ?? '');
  if (!Object.hasOwn(TIPOS, tipo)) throw invalido('Elige un tipo de producto.');
  const n = nombre(body?.nombre, MAX_NOMBRE, 'subtipo');
  return sinCarreras(() => withTransaction(pool, async (db) => {
    await bloquear(db);
    await subtipoRepetido(db, tipo, n);
    const row = (await db.query('INSERT INTO product_subtypes (type, name) VALUES ($1, $2) RETURNING id', [tipo, n])).rows[0];
    return { id: row.id, tipo, nombre: n };
  }));
}

export async function editarSubtipo(pool, idRaw, body) {
  const id = leerId(idRaw, 'Ese subtipo');
  const n = nombre(body?.nombre, MAX_NOMBRE, 'subtipo');
  return withTransaction(pool, async (db) => {
    await bloquear(db);
    const antes = (await db.query('SELECT type, name FROM product_subtypes WHERE id = $1', [id])).rows[0];
    if (!antes) throw noExiste('Ese subtipo');
    await subtipoRepetido(db, antes.type, n, id);
    await db.query('UPDATE product_subtypes SET name = $2 WHERE id = $1', [id, n]);
    return { id, tipo: antes.type, antes: antes.name, nombre: n };
  });
}

/** Borra un subtipo: sus productos se quedan sin subtipo y los fabricantes que solo lo tenían a él pasan a todo su tipo. */
export async function borrarSubtipo(pool, idRaw) {
  const id = leerId(idRaw, 'Ese subtipo');
  return withTransaction(pool, async (db) => {
    await bloquear(db);
    const s = (await db.query('SELECT type, name FROM product_subtypes WHERE id = $1', [id])).rows[0];
    if (!s) throw noExiste('Ese subtipo');
    const n = (await db.query('SELECT count(*)::int AS n FROM inventory_items WHERE subtype_id = $1', [id])).rows[0].n;
    await db.query(`INSERT INTO product_brand_scopes (brand_id, type)
                    SELECT a.brand_id, a.type FROM product_brand_scopes a
                     WHERE a.subtype_id = $1
                       AND NOT EXISTS (SELECT 1 FROM product_brand_scopes o WHERE o.brand_id = a.brand_id AND o.type = a.type AND o.subtype_id IS DISTINCT FROM $1)
                    ON CONFLICT DO NOTHING`, [id]);
    await db.query('DELETE FROM product_subtypes WHERE id = $1', [id]);
    return { id, tipo: s.type, nombre: s.name, productos: n };
  });
}

/* ---------- Fabricantes ---------- */

/** Ámbitos [{tipo, subtipo_id}] válidos y sin repetir (un tipo entero absorbe sus subtipos). */
async function leerAmbitos(db, valor) {
  if (valor == null) return [];
  if (!Array.isArray(valor) || valor.length > MAX_AMBITOS) throw invalido('Lista de tipos no válida.');
  const subtipos = new Map((await db.query('SELECT id, type FROM product_subtypes')).rows.map((s) => [s.id, s.type]));
  const enteros = new Set();
  const sueltos = new Map();
  for (const a of valor) {
    const tipo = String(a?.tipo ?? '');
    if (!Object.hasOwn(TIPOS, tipo)) throw invalido('Tipo de producto no válido.');
    if (a.subtipo_id == null || a.subtipo_id === '') { enteros.add(tipo); continue; }
    const sid = Number(a.subtipo_id);
    if (!idValido(sid) || subtipos.get(sid) !== tipo) throw invalido(`Subtipo no válido para ${TIPOS[tipo].nombre.toLowerCase()}.`);
    sueltos.set(sid, tipo);
  }
  return [
    ...[...enteros].map((tipo) => ({ tipo, subtipo_id: null })),
    ...[...sueltos].filter(([, tipo]) => !enteros.has(tipo)).map(([sid, tipo]) => ({ tipo, subtipo_id: sid })),
  ];
}

/** Proveedor de un fabricante: null (ninguno) o el id de uno que exista. */
async function leerProveedor(db, valor) {
  if (valor == null || valor === '') return null;
  const id = Number(valor);
  if (!idValido(id)) throw invalido('Proveedor no válido.');
  const p = (await db.query('SELECT id, name FROM suppliers WHERE id = $1 FOR SHARE', [id])).rows[0];
  if (!p) throw noExiste('Ese proveedor');
  return { id: p.id, nombre: p.name };
}

async function guardarAmbitos(db, brandId, ambitos) {
  await db.query('DELETE FROM product_brand_scopes WHERE brand_id = $1', [brandId]);
  if (!ambitos.length) return;
  await db.query(`INSERT INTO product_brand_scopes (brand_id, type, subtype_id)
                  SELECT $1, t, NULLIF(s, 0) FROM unnest($2::text[], $3::int[]) AS x(t, s)`,
  [brandId, ambitos.map((a) => a.tipo), ambitos.map((a) => a.subtipo_id ?? 0)]);
}

export async function crearMarca(pool, body) {
  const n = nombre(body?.nombre, MAX_NOMBRE, 'fabricante');
  return sinCarreras(() => withTransaction(pool, async (db) => {
    await bloquear(db);
    const ambitos = await leerAmbitos(db, body?.ambitos);
    const proveedor = await leerProveedor(db, body?.proveedor_id);
    let id;
    try {
      id = (await db.query('INSERT INTO product_brands (name, supplier_id) VALUES ($1, $2) RETURNING id', [n, proveedor?.id ?? null])).rows[0].id;
    } catch (e) {
      if (repetido(e)) throw conflicto(`Ya hay un fabricante «${n}».`, 'DUPLICATE');
      throw e;
    }
    await guardarAmbitos(db, id, ambitos);
    return { id, nombre: n, ambitos, proveedor };
  }));
}

/** Cambia nombre y ámbitos. El nombre nuevo también se pone a sus productos del inventario. */
export async function editarMarca(pool, idRaw, body) {
  const id = leerId(idRaw, 'Ese fabricante');
  const n = nombre(body?.nombre, MAX_NOMBRE, 'fabricante');
  return sinCarreras(() => withTransaction(pool, async (db) => {
    await bloquear(db);
    const antes = (await db.query(`SELECT b.name, b.supplier_id, s.name AS supplier_name FROM product_brands b
                                    LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1 FOR UPDATE OF b`, [id])).rows[0];
    if (!antes) throw noExiste('Ese fabricante');
    const proveedorAntes = antes.supplier_id ? { id: antes.supplier_id, nombre: antes.supplier_name } : null;
    // Sin «proveedor_id» en la petición se deja el que tenía.
    const proveedor = body && Object.hasOwn(body, 'proveedor_id') ? await leerProveedor(db, body.proveedor_id) : proveedorAntes;
    const ambitosAntes = (await db.query('SELECT type AS tipo, subtype_id FROM product_brand_scopes WHERE brand_id = $1 ORDER BY type, subtype_id NULLS FIRST', [id])).rows;
    const ambitos = await leerAmbitos(db, body?.ambitos);
    let renombrados = 0;
    try {
      await db.query('UPDATE product_brands SET name = $2, supplier_id = $3 WHERE id = $1', [id, n, proveedor?.id ?? null]);
      if (n !== antes.name) {
        renombrados = (await db.query('UPDATE inventory_items SET brand = $2, updated_at = NOW() WHERE lower(brand) = lower($1)', [antes.name, n])).rowCount;
      }
    } catch (e) {
      if (repetido(e)) {
        throw conflicto(e.table === 'inventory_items' || e.constraint?.startsWith('inventory_items')
          ? `No se puede renombrar: ya hay productos de «${n}» iguales a algunos de «${antes.name}» (misma referencia, color y talla).`
          : `Ya hay un fabricante «${n}».`, 'DUPLICATE');
      }
      throw e;
    }
    await guardarAmbitos(db, id, ambitos);
    return {
      id,
      antes: { nombre: antes.name, proveedor: proveedorAntes, ambitos: ambitosAntes.map((a) => ({ tipo: a.tipo, subtipo_id: a.subtype_id })) },
      despues: { nombre: n, proveedor, ambitos },
      renombrados,
    };
  }));
}

export async function borrarMarca(pool, idRaw) {
  const id = leerId(idRaw, 'Ese fabricante');
  return withTransaction(pool, async (db) => {
    await bloquear(db);
    const b = (await db.query('SELECT name FROM product_brands WHERE id = $1', [id])).rows[0];
    if (!b) throw noExiste('Ese fabricante');
    const n = (await db.query('SELECT count(*)::int AS n FROM inventory_items WHERE lower(brand) = lower($1)', [b.name])).rows[0].n;
    if (n) throw conflicto(`No se puede borrar «${b.name}»: tiene ${productos(n)} en el inventario. Si ha cambiado de nombre, edítalo.`);
    await db.query('DELETE FROM product_brands WHERE id = $1', [id]);
    return { id, nombre: b.name };
  });
}

/**
 * Los fabricantes usados en un alta entran en el catálogo si no estaban, y
 * se les añade el tipo si tenían ámbitos y no lo incluían (con «todos los
 * tipos» no hace falta). Va dentro de la transacción del alta.
 * Si el alta viene de un pedido o factura, los fabricantes que aún no tienen
 * proveedor quedan con el de ese documento.
 * @param {{ marca: string, tipo: string }[]} usos
 * @param {{ proveedorId?: number|null }} [opciones]
 */
export async function asegurarMarcas(db, usos, { proveedorId = null } = {}) {
  const pares = [...new Map(usos.map((u) => ({ ...u, marca: String(u.marca ?? '').trim() }))
    .filter((u) => u.marca && u.marca.length <= MAX_NOMBRE && Object.hasOwn(TIPOS, u.tipo))
    .map((u) => [`${u.marca.toLowerCase()}|${u.tipo}`, u])).values()];
  if (!pares.length) return;
  const nombres = pares.map((u) => u.marca);
  const tipos = pares.map((u) => u.tipo);
  const nuevas = (await db.query(`INSERT INTO product_brands (name)
                  SELECT DISTINCT ON (lower(m)) m FROM unnest($1::text[]) AS m ORDER BY lower(m), m
                  ON CONFLICT DO NOTHING RETURNING id`, [nombres])).rows.map((r) => r.id);
  // Una marca nueva recibe los tipos con los que se usa; una que ya tenía
  // ámbitos, el tipo que le falte. Las de «todos los tipos» se dejan igual.
  await db.query(`INSERT INTO product_brand_scopes (brand_id, type)
                  SELECT b.id, x.t FROM unnest($1::text[], $2::text[]) AS x(m, t)
                  JOIN product_brands b ON lower(b.name) = lower(x.m)
                  WHERE b.id = ANY($3::int[])
                     OR (EXISTS (SELECT 1 FROM product_brand_scopes s WHERE s.brand_id = b.id)
                         AND NOT EXISTS (SELECT 1 FROM product_brand_scopes s WHERE s.brand_id = b.id AND s.type = x.t))
                  ON CONFLICT DO NOTHING`, [nombres, tipos, nuevas]);
  if (proveedorId) {
    await db.query(`UPDATE product_brands SET supplier_id = $2
                    WHERE supplier_id IS NULL AND lower(name) = ANY(SELECT lower(m) FROM unnest($1::text[]) AS m)`, [nombres, proveedorId]);
  }
}

/* ---------- Sugerencias para el formulario de alta ---------- */

const MAX_SUGERENCIAS = 300;
const filtro = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Modelos, referencias, colores y tallas que ya hay en el inventario para lo
 * elegido hasta ahora (fabricante, tipo, modelo, referencia): así el
 * formulario propone lo que existe sin impedir escribir algo nuevo.
 */
export async function sugerencias(db, q = {}) {
  const marca = filtro(q.marca, MAX_NOMBRE);
  if (!marca) return { modelos: [], referencias: [], colores: [], tallas: [] };
  const tipo = Object.hasOwn(TIPOS, String(q.tipo ?? '')) ? String(q.tipo) : null;
  const modelo = filtro(q.modelo, 100) || null;
  const referencia = filtro(q.referencia, 50) || null;
  const distintos = async (col, extra, orden = col) => (await db.query(
    `SELECT ${col} AS v FROM inventory_items
      WHERE lower(brand) = lower($1) AND ($2::text IS NULL OR type = $2) ${extra} AND ${col} <> ''
      GROUP BY ${col} ORDER BY min(${orden}), ${col} LIMIT ${MAX_SUGERENCIAS}`,
    [marca, tipo, modelo, referencia],
  )).rows.map((r) => r.v);
  const porModelo = 'AND ($3::text IS NULL OR lower(model) = lower($3))';
  const porRef = 'AND ($4::text IS NULL OR lower(reference) = lower($4))';
  const [modelos, referencias, colores, tallas] = await Promise.all([
    distintos('model', 'AND $3::text IS NOT DISTINCT FROM $3 AND $4::text IS NOT DISTINCT FROM $4', 'lower(model)'),
    distintos('reference', `${porModelo} AND $4::text IS NOT DISTINCT FROM $4`, 'reference'),
    distintos('color', `${porModelo} ${porRef}`, 'lower(color)'),
    distintos('size', `${porModelo} ${porRef}`, 'size_order'),
  ]);
  return { modelos, referencias, colores, tallas };
}
