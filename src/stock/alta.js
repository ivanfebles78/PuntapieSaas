// Alta de productos en el inventario sin pedido ni factura: uno a uno o desde
// un Excel (el género que ya hay en la tienda de otros años). Se hace en dos
// pasos: `revisarAlta` dice qué pasará con cada fila sin tocar nada y
// `confirmarAlta` lo aplica todo junto (o nada).
//
// Con cada fila:
// - si el producto (marca + modelo + referencia + color + talla) no existe, se crea;
// - si existe y los datos coinciden, sus unidades se suman al stock;
// - si existe pero algún dato es distinto (tipo, subtipo, coste, PVP, código,
//   detalle), se pregunta: actualizar los datos, mantener los actuales o no importarla.
// Un dato vacío en la fila no cuenta como distinto: completa el del artículo si lo tenía vacío.
//
// Código de barras: un «200…» (de las etiquetas de la web antigua) queda como el
// código del artículo; otro (el de fábrica, de la caja) se guarda como código de
// fábrica y el artículo recibe un «200…» nuevo. Sin código, se genera uno.
import { HttpError } from '../http-error.js';
import { withTransaction } from '../proveedores/repo.js';
import { esEan13, nuevoCodigo } from './barcode.js';
import { asegurarMarcas } from './catalogo.js';
import { leerTalla, tallaParaTipo, tipoPorDefecto, TIPOS } from './tipos.js';

export const MAX_FILAS_ALTA = 2000;
const MAX_UNIDADES = 1000;
const MAX_CENTS = 10_000_000; // 100.000,00 €
const MAX_DETALLE = 200;
const INTENTOS_CODIGO = 10;
const CANDADO_ALTA = 'puntapie:stock:alta';
export const DECISIONES = Object.freeze(['actualizar', 'mantener', 'omitir']);

const texto = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const sinTildes = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

// Cómo se escribe el tipo en un Excel: «Calzado», «zapatos», «Accesorio»…
const NOMBRES_TIPO = Object.freeze({
  calzado: 'calzado', zapato: 'calzado', zapatos: 'calzado', zapatilla: 'calzado', zapatillas: 'calzado',
  ropa: 'ropa', prenda: 'ropa', prendas: 'ropa', textil: 'ropa',
  accesorio: 'accesorios', accesorios: 'accesorios', accessorios: 'accesorios', complemento: 'accesorios', complementos: 'accesorios',
  juguete: 'juguetes', juguetes: 'juguetes', juego: 'juguetes', juegos: 'juguetes',
});

/** Tipo por su clave o su nombre en el catálogo (Admin › Catálogo), o por las formas de siempre. */
function leerTipo(v) {
  const t = sinTildes(v);
  if (!t) return undefined;
  const porNombre = Object.keys(TIPOS).find((id) => id === t || sinTildes(TIPOS[id].nombre) === t);
  if (porNombre) return porNombre;
  const alias = Object.hasOwn(NOMBRES_TIPO, t) ? NOMBRES_TIPO[t] : undefined;
  return alias && Object.hasOwn(TIPOS, alias) ? alias : undefined;
}

/** Euros a céntimos: 12,5 · «12,50» · «1.234,50 €» · 12.5. Vacío = null. */
export function leerEuros(v) {
  if (vacio(v)) return { ok: true, cent: null };
  let n;
  if (typeof v === 'number') n = v;
  else {
    const limpio = String(v).trim().replace(/\s|€/g, '');
    // «1.500» sin coma es mil quinientos (punto de miles); «19.95», decimales.
    const miles = !limpio.includes(',') && /^\d{1,3}(\.\d{3})+$/.test(limpio);
    const normal = limpio.includes(',') || miles ? limpio.replace(/\./g, '').replace(',', '.') : limpio;
    n = /^\d+(\.\d+)?$/.test(normal) ? Number(normal) : NaN;
  }
  const cent = Math.round(n * 100);
  return Number.isFinite(n) && n >= 0 && cent <= MAX_CENTS ? { ok: true, cent } : { ok: false, cent: null };
}

/**
 * Código de barras escrito en la fila. Devuelve { interno } (un «200…» propio),
 * { fabrica } (otro) o { error }. Un EAN-13 que Excel guardó como número pierde
 * el 0 inicial: con 12 cifras que lo son con el 0 delante, se le devuelve.
 */
export function leerCodigo(v) {
  if (vacio(v)) return {};
  let code = typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v).replace(/[\s-]/g, '');
  if (!/^\d{8,14}$/.test(code)) return { error: `código de barras «${texto(v, 20)}» no válido: deben ser de 8 a 14 cifras` };
  if (code.length === 12 && esEan13(`0${code}`)) code = `0${code}`;
  if (code.length === 13 && !esEan13(code)) return { error: `el código de barras ${code} no es un EAN-13 válido (revisa la última cifra)` };
  return /^200\d{10}$/.test(code) ? { interno: code } : { fabrica: code };
}

function leerUnidades(v) {
  if (vacio(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isInteger(n) && n >= 0 && n <= MAX_UNIDADES ? n : null;
}

/**
 * Normaliza una fila (del formulario o del Excel). La talla se lee sin el tipo
 * cuando no viene: si el artículo ya existe, vale el tipo que tiene.
 * @returns {{ datos?: object, errores: string[] }}
 */
function leerFila(raw, subtipos) {
  const errores = [];
  const tipoDado = vacio(raw?.tipo) ? null : leerTipo(raw.tipo);
  if (tipoDado === undefined) errores.push(`tipo «${texto(raw.tipo, 30)}» no válido: usa Calzado, Ropa, Accesorios o Juguetes`);
  const marca = texto(raw?.marca, 50);
  const referencia = texto(raw?.referencia, 50);
  const modelo = texto(raw?.modelo, 100); // vacío: el del artículo que ya existe, o la referencia
  const color = texto(raw?.color, 50);
  const detalle = texto(raw?.detalle, MAX_DETALLE);
  const tallaRaw = raw?.talla == null ? '' : String(raw.talla);
  const talla = tipoDado ? tallaParaTipo(tallaRaw, tipoDado) : leerTalla(tallaRaw);
  const coste = leerEuros(raw?.coste);
  const pvp = leerEuros(raw?.pvp);
  const unidades = leerUnidades(raw?.unidades);
  const codigo = leerCodigo(raw?.codigo);
  if (!marca) errores.push('falta el fabricante');
  if (!referencia) errores.push('falta la referencia');
  if (!talla || talla.ok === false) errores.push(talla?.error ?? `talla «${tallaRaw.trim() || 'vacía'}» no válida`);
  if (!coste.ok) errores.push('precio de coste no válido');
  if (!pvp.ok) errores.push('PVP no válido');
  if (unidades === null) errores.push(`unidades no válidas (de 0 a ${MAX_UNIDADES})`);
  if (codigo.error) errores.push(codigo.error);
  let subtipoId = null;
  if (!vacio(raw?.subtipo) && tipoDado) {
    const s = subtipos.find((x) => x.type === tipoDado && sinTildes(x.name) === sinTildes(raw.subtipo));
    if (s) subtipoId = s.id;
    else errores.push(`el subtipo «${texto(raw.subtipo, 40)}» no existe en ${TIPOS[tipoDado].nombre.toLowerCase()}`);
  } else if (!vacio(raw?.subtipo)) errores.push('para indicar el subtipo, indica también el tipo');
  if (errores.length) return { errores };
  return {
    errores,
    datos: {
      tipo: tipoDado, subtipo_id: subtipoId, marca, modelo, referencia, color, talla: talla.talla, orden_talla: talla.orden,
      detalle, coste_cent: coste.cent, pvp_cent: pvp.cent, unidades, codigo: codigo.interno ?? null, codigo_fabricante: codigo.fabrica ?? null,
    },
  };
}

const claveSku = (d) => [d.marca, d.modelo || d.referencia, d.referencia, d.color, d.talla].map((x) => x.toLowerCase()).join('|');
// Datos que no forman el SKU: dos filas del mismo SKU tienen que coincidir en ellos.
const DATOS = Object.freeze(['tipo', 'subtipo_id', 'detalle', 'coste_cent', 'pvp_cent', 'codigo', 'codigo_fabricante']);

/** Junta las filas del mismo SKU (suma unidades) si sus datos coinciden. */
function juntarFilas(leidas, errores) {
  const porSku = new Map();
  for (const { fila, datos } of leidas) {
    const key = claveSku(datos);
    const previa = porSku.get(key);
    if (!previa) {
      porSku.set(key, { filas: [fila], datos });
      continue;
    }
    const distinto = DATOS.find((k) => !vacio(datos[k]) && !vacio(previa.datos[k]) && datos[k] !== previa.datos[k]);
    if (distinto) {
      errores.push({ fila, errores: [`es el mismo producto que la fila ${previa.filas[0]} pero con otros datos: déjalo en una sola fila`] });
      continue;
    }
    const juntos = Object.fromEntries(DATOS.map((k) => [k, vacio(previa.datos[k]) ? datos[k] : previa.datos[k]]));
    porSku.set(key, { filas: [...previa.filas, fila], datos: { ...previa.datos, ...juntos, unidades: previa.datos.unidades + datos.unidades } });
  }
  return [...porSku.values()];
}

/** Artículos que encajan con cada grupo (sin modelo, vale cualquier modelo de esa referencia). */
async function articulosPorSku(db, grupos) {
  if (!grupos.length) return new Map();
  const cols = ['marca', 'modelo', 'referencia', 'color', 'talla'].map((k) => grupos.map((g) => g.datos[k]));
  const rows = (await db.query(`
    SELECT a.*, k.i FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS k(b, m, r, c, s, i)
    JOIN inventory_items a ON lower(a.brand) = lower(k.b) AND (k.m = '' OR lower(a.model) = lower(k.m)) AND lower(a.reference) = lower(k.r)
      AND lower(a.color) = lower(k.c) AND lower(a.size) = lower(k.s)
    ORDER BY k.i, a.id`, cols)).rows;
  const porGrupo = new Map();
  for (const r of rows) porGrupo.set(Number(r.i) - 1, [...(porGrupo.get(Number(r.i) - 1) ?? []), r]);
  return porGrupo;
}

async function articulosPorCodigo(db, grupos) {
  const codigos = [...new Set(grupos.flatMap((g) => [g.datos.codigo, g.datos.codigo_fabricante]).filter(Boolean))];
  if (!codigos.length) return [];
  return (await db.query('SELECT * FROM inventory_items WHERE barcode = ANY($1::text[]) OR maker_barcode = ANY($1::text[])', [codigos])).rows;
}

const etiquetaSku = (a) => `${a.brand} ${a.reference} ${a.color} T. ${a.size}`.replace(/\s+/g, ' ');
const euros = (c) => (c == null ? '—' : `${(c / 100).toFixed(2).replace('.', ',')} €`);

/** Lo que cambia en un artículo que ya existe: diferencias (se pregunta) y huecos (se completan). */
function compararConArticulo(d, a, subtipos) {
  const nombreSub = (id) => subtipos.find((s) => s.id === id)?.name ?? '—';
  const errores = [];
  const diferencias = [];
  const completar = {};
  const comparar = (campo, etiqueta, nuevo, actual, columna, mostrar = (v) => v) => {
    if (vacio(nuevo) || nuevo === actual) return;
    if (vacio(actual)) completar[columna] = nuevo;
    else diferencias.push({ campo, etiqueta, actual: mostrar(actual), nuevo: mostrar(nuevo), columna, valor: nuevo });
  };
  const otroTipo = Boolean(d.tipo && d.tipo !== a.type);
  if (otroTipo) {
    const t = tallaParaTipo(a.size, d.tipo);
    if (!t.ok) errores.push(`ya existe como ${TIPOS[a.type].nombre.toLowerCase()} y su talla no vale para ${TIPOS[d.tipo].nombre.toLowerCase()}`);
    else diferencias.push({ campo: 'tipo', etiqueta: 'Tipo', actual: TIPOS[a.type].nombre, nuevo: TIPOS[d.tipo].nombre, columna: 'type', valor: d.tipo });
  }
  // El subtipo es de un tipo: si el tipo cambia, el subtipo va con él (y solo si se actualiza).
  if (otroTipo && d.subtipo_id != null) {
    diferencias.push({ campo: 'subtipo', etiqueta: 'Subtipo', actual: nombreSub(a.subtype_id), nuevo: nombreSub(d.subtipo_id), columna: 'subtype_id', valor: d.subtipo_id });
  } else if (!otroTipo && d.subtipo_id != null) comparar('subtipo', 'Subtipo', d.subtipo_id, a.subtype_id, 'subtype_id', nombreSub);
  comparar('coste', 'Precio coste', d.coste_cent, a.cost_cents, 'cost_cents', euros);
  comparar('pvp', 'PVP', d.pvp_cent, a.sale_price_cents, 'sale_price_cents', euros);
  // El detalle guardado puede ser más largo o tener otros espacios: se compara normalizado.
  const detalleActual = texto(a.detail, MAX_DETALLE);
  if (d.detalle && detalleActual !== d.detalle) comparar('detalle', 'Detalle', d.detalle, a.detail, 'detail');
  if (d.codigo && d.codigo !== a.barcode) errores.push(`ya existe con el código ${a.barcode}, no con ${d.codigo}`);
  if (d.codigo_fabricante && d.codigo_fabricante !== a.barcode) comparar('codigo_fabricante', 'Código de fábrica', d.codigo_fabricante, a.maker_barcode, 'maker_barcode');
  return { errores, diferencias, completar };
}

/**
 * Qué pasará con cada fila, sin cambiar nada.
 * @param {object[]} filas filas crudas: { fila?, tipo, subtipo, marca, modelo, referencia, talla, color, coste, pvp, unidades, codigo, detalle }
 * @returns {Promise<{ lineas: object[], errores: { fila, errores }[], resumen: object }>}
 */
export async function revisarAlta(db, filas) {
  if (!Array.isArray(filas) || !filas.length) throw new HttpError(400, 'No hay productos que dar de alta.', 'NO_ROWS');
  if (filas.length > MAX_FILAS_ALTA) throw new HttpError(400, `Como mucho ${MAX_FILAS_ALTA} filas de una vez: divide el Excel.`, 'TOO_MANY_ROWS');
  const subtipos = (await db.query('SELECT id, type, name FROM product_subtypes')).rows;
  const errores = [];
  const leidas = [];
  filas.forEach((raw, i) => {
    const fila = Number.isInteger(raw?.fila) && raw.fila > 0 ? raw.fila : i + 1;
    const r = leerFila(raw, subtipos);
    if (r.errores.length) errores.push({ fila, errores: r.errores });
    else leidas.push({ fila, datos: r.datos });
  });
  const grupos = juntarFilas(leidas, errores);
  const [porSku, conCodigo] = await Promise.all([articulosPorSku(db, grupos), articulosPorCodigo(db, grupos)]);
  const codigoEnFichero = new Map();
  const lineas = [];
  grupos.forEach((g, i) => {
    const candidatos = porSku.get(i) ?? [];
    const a = candidatos[0] ?? null;
    const d = { ...g.datos, modelo: g.datos.modelo || a?.model || g.datos.referencia };
    const fallos = [];
    if (!g.datos.modelo && candidatos.length > 1) {
      fallos.push(`hay ${candidatos.length} modelos con la referencia ${d.referencia} en ese color y talla: indica el modelo`);
    }
    for (const code of [d.codigo, d.codigo_fabricante].filter(Boolean)) {
      const otro = conCodigo.find((x) => (x.barcode === code || x.maker_barcode === code) && x.id !== a?.id);
      if (otro) fallos.push(`el código ${code} ya es de otro artículo (${etiquetaSku(otro)})`);
      const repetido = codigoEnFichero.get(code);
      if (repetido && repetido !== claveSku(d)) fallos.push(`el código ${code} está también en otro producto del fichero`);
      codigoEnFichero.set(code, claveSku(d));
    }
    let linea = { filas: g.filas, datos: { ...d, tipo: d.tipo ?? a?.type ?? tipoPorDefecto(d.talla) }, articulo: null, diferencias: [], completar: {} };
    if (a) {
      const c = compararConArticulo(d, a, subtipos);
      fallos.push(...c.errores);
      linea = { ...linea, articulo: a, diferencias: c.diferencias, completar: c.completar };
    } else {
      const t = tallaParaTipo(d.talla, linea.datos.tipo);
      if (!t.ok) fallos.push(t.error);
      if (!d.color && TIPOS[linea.datos.tipo].color) fallos.push(`falta el color (${TIPOS[linea.datos.tipo].nombre.toLowerCase()} lo pide)`);
    }
    if (fallos.length) errores.push({ fila: g.filas[0], errores: fallos });
    else lineas.push({ ...linea, estado: !a ? 'nuevo' : linea.diferencias.length ? 'conflicto' : 'sumar' });
  });
  errores.sort((x, y) => x.fila - y.fila);
  return { lineas, errores, resumen: resumir(lineas) };
}

function resumir(lineas) {
  const cuenta = (estado) => lineas.filter((l) => l.estado === estado).length;
  return { nuevos: cuenta('nuevo'), sumar: cuenta('sumar'), conflictos: cuenta('conflicto'), unidades: lineas.reduce((s, l) => s + l.datos.unidades, 0) };
}

/** La revisión, como la ve la pantalla (sin columnas de la base de datos). */
export function revisionPublica({ lineas, errores, resumen }) {
  return {
    resumen,
    errores,
    lineas: lineas.map((l, i) => ({
      n: i,
      filas: l.filas,
      estado: l.estado,
      clave: claveSku(l.datos),
      tipo: l.datos.tipo,
      marca: l.datos.marca,
      modelo: l.datos.modelo,
      referencia: l.datos.referencia,
      color: l.datos.color,
      talla: l.datos.talla,
      unidades: l.datos.unidades,
      pvp_cent: l.datos.pvp_cent ?? l.articulo?.sale_price_cents ?? null,
      coste_cent: l.datos.coste_cent ?? l.articulo?.cost_cents ?? null,
      codigo: l.articulo?.barcode ?? l.datos.codigo ?? null,
      stock_actual: l.articulo?.stock ?? null,
      diferencias: l.diferencias.map(({ campo, etiqueta, actual, nuevo }) => ({ campo, etiqueta, actual, nuevo })),
    })),
  };
}

// Recepción de mercancía y la ficha del artículo no toman el candado del alta:
// si cambian lo mismo entre la revisión y el guardado, se pide revisar otra vez.
const cambiadoMientras = () => new HttpError(409, 'Mientras tanto se dio de alta o cambió alguno de estos productos: vuelve a revisar.', 'CHANGED_MEANWHILE');

async function conCarrera(consulta) {
  try {
    return await consulta();
  } catch (error) {
    if (error.code === '23505') throw cambiadoMientras();
    throw error;
  }
}

async function crearArticulo(client, d) {
  const valores = (codigo) => [d.marca, d.modelo, d.referencia, d.color, d.talla, codigo, d.unidades, d.coste_cent, d.pvp_cent,
    d.tipo, d.subtipo_id, d.detalle, d.orden_talla, d.codigo_fabricante];
  const insertar = (codigo) => conCarrera(() => client.query(
    `INSERT INTO inventory_items (brand, model, reference, color, size, barcode, stock, cost_cents, sale_price_cents, type, subtype_id, detail, size_order, maker_barcode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`, valores(codigo)));
  if (d.codigo) return (await insertar(d.codigo)).rows[0];
  for (let intento = 0; intento < INTENTOS_CODIGO; intento += 1) {
    const codigo = nuevoCodigo();
    const libre = (await client.query('SELECT 1 FROM inventory_items WHERE barcode = $1 OR maker_barcode = $1', [codigo])).rowCount === 0;
    if (libre) return (await insertar(codigo)).rows[0];
  }
  throw new HttpError(500, 'No se pudo generar un código de barras único.', 'BARCODE_EXHAUSTED');
}

async function sumarArticulo(client, a, unidades, cambios) {
  const columnas = Object.keys(cambios);
  const sets = columnas.map((c, i) => `${c} = $${i + 3}`);
  const row = (await conCarrera(() => client.query(
    `UPDATE inventory_items SET stock = stock + $2, ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE id = $1 RETURNING *`,
    [a.id, unidades, ...columnas.map((c) => cambios[c])],
  ))).rows[0];
  if (!row) throw cambiadoMientras();
  return row;
}

/**
 * Aplica el alta. `decisiones` = { [clave]: 'actualizar' | 'mantener' | 'omitir' }
 * para cada producto que existe con otros datos (la clave es la de la revisión).
 * Vuelve a revisar dentro de la transacción: si algo cambió desde la vista
 * previa y hay errores o una diferencia sin decidir, no aplica nada.
 */
export async function confirmarAlta(pool, filas, decisiones = {}) {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CANDADO_ALTA]);
    const revision = await revisarAlta(client, filas);
    if (revision.errores.length) {
      throw new HttpError(400, 'Hay filas con errores: corrígelas y vuelve a revisar.', 'ROWS_INVALID', { ...revisionPublica(revision) });
    }
    const decision = (l) => (Object.hasOwn(decisiones ?? {}, claveSku(l.datos)) ? decisiones[claveSku(l.datos)] : undefined);
    const sinDecidir = revision.lineas.filter((l) => l.estado === 'conflicto' && !DECISIONES.includes(decision(l)));
    if (sinDecidir.length) {
      throw new HttpError(409, `Falta decidir qué hacer con ${sinDecidir.length} producto${sinDecidir.length === 1 ? '' : 's'} que ya existe${sinDecidir.length === 1 ? '' : 'n'} con otros datos.`,
        'DECISION_REQUIRED', { ...revisionPublica(revision) });
    }
    const ids = revision.lineas.filter((l) => l.articulo).map((l) => l.articulo.id).sort((x, y) => x - y);
    if (ids.length) await client.query('SELECT id FROM inventory_items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    const hechos = [];
    for (const l of revision.lineas) {
      const accion = l.estado === 'conflicto' ? decision(l) : l.estado;
      if (accion === 'omitir') {
        hechos.push({ accion, articulo: l.articulo, unidades: 0, antes: l.articulo.stock });
        continue;
      }
      if (accion === 'nuevo') {
        hechos.push({ accion, articulo: await crearArticulo(client, l.datos), unidades: l.datos.unidades, antes: 0 });
        continue;
      }
      const cambios = accion === 'actualizar'
        ? { ...l.completar, ...Object.fromEntries(l.diferencias.map((x) => [x.columna, x.valor])) }
        : l.completar;
      // Un subtipo de otro tipo no vale: al cambiar de tipo sin subtipo nuevo, se quita.
      const conSubtipo = cambios.type && !Object.hasOwn(cambios, 'subtype_id') ? { ...cambios, subtype_id: null } : cambios;
      const a = await sumarArticulo(client, l.articulo, l.datos.unidades, conSubtipo);
      hechos.push({ accion, articulo: a, unidades: l.datos.unidades, antes: l.articulo.stock });
    }
    // Un fabricante nuevo (o usado en otro tipo) queda en el catálogo para la próxima vez.
    await asegurarMarcas(client, hechos.filter((x) => x.accion !== 'omitir').map((x) => ({ marca: x.articulo.brand, tipo: x.articulo.type })));
    return hechos;
  });
}

/** Resumen de lo hecho, para la respuesta y el log. */
export function resumenAlta(hechos) {
  const cuenta = (accion) => hechos.filter((x) => x.accion === accion).length;
  return {
    nuevos: cuenta('nuevo'),
    sumados: cuenta('sumar') + cuenta('mantener') + cuenta('actualizar'),
    actualizados: cuenta('actualizar'),
    omitidos: cuenta('omitir'),
    unidades: hechos.reduce((s, x) => s + x.unidades, 0),
  };
}

export { etiquetaSku };
