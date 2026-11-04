import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { eur, subir } from '../proveedores/util.js';
import { showToast } from '../toast.js';

// Stock › Inventario › alta de productos sin pedido (lo que ya hay en la
// tienda): uno a uno («Nuevo producto») o desde un Excel. Si el producto ya
// existe con los mismos datos se suman sus unidades; si algún dato es
// distinto, se pregunta antes de guardar. Al final se ofrecen las etiquetas.

const API = '/api/stock/alta';
const MAX_ERRORES = 40;
const MAX_LINEAS = 300;
const uds = (n) => `${n} ${n === 1 ? 'ud.' : 'uds.'}`;
const tallaTxt = (t) => (t === 'Única' ? 'talla única' : `T. ${t}`);
const producto = (l) => `${l.marca} ${l.referencia}${l.modelo && l.modelo !== l.referencia ? ` · ${l.modelo}` : ''}${l.color ? ` · ${l.color}` : ''}`;

const campo = (id, label, control, ayuda, ancho = false) => h('label', { class: `pfield${ancho ? ' pfield-wide' : ''}`, for: id }, [
  h('span', { text: label }), control, ayuda ? h('small', { class: 'pmuted', text: ayuda }) : null,
]);
const entrada = (id, value, attrs = {}) => h('input', { id, type: 'text', value: value ?? '', ...attrs });

function opcionesSubtipo(select, tipo, tipos, actual) {
  const subtipos = tipos.find((t) => t.id === tipo)?.subtipos ?? [];
  select.replaceChildren(h('option', { value: '', text: '— Sin subtipo —' }),
    ...subtipos.map((s) => h('option', { value: s.nombre, text: s.nombre, selected: s.nombre === actual })));
}

const OTRA_MARCA = '__otra__';
const igual = (a, b) => a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es');

/** Fabricantes del catálogo para ese tipo y subtipo (sin ámbitos = para todos). */
export function marcasPara(marcas, tipo, subtipoId) {
  return marcas.filter((m) => !m.ambitos.length
    || m.ambitos.some((a) => a.tipo === tipo && (a.subtipo_id == null || subtipoId == null || a.subtipo_id === subtipoId)));
}

/**
 * Fabricante: un desplegable con los del tipo y subtipo elegidos y «Otro…»
 * para escribir uno nuevo (que entra en el catálogo al guardar).
 */
function campoMarca(marcas, previo) {
  const select = h('select', { id: 'alta-marca' });
  const otra = h('input', { id: 'alta-marca-otra', type: 'text', maxlength: '50', autocomplete: 'off', placeholder: 'Nombre del fabricante', 'aria-label': 'Nombre del fabricante nuevo', hidden: true });
  const ayuda = h('small', { class: 'pmuted' });
  const mostrarOtra = () => {
    otra.hidden = select.value !== OTRA_MARCA;
    if (!otra.hidden) otra.focus();
  };
  select.addEventListener('change', mostrarOtra);
  const valor = () => (select.value === OTRA_MARCA ? otra.value.trim() : select.value);
  function opciones(tipo, subtipoId, nombreTipo) {
    const actual = valor() || previo || '';
    const lista = marcasPara(marcas, tipo, subtipoId).map((m) => m.nombre);
    // El que ya estaba elegido se queda aunque sea de otro tipo (o nuevo).
    const conocida = actual && marcas.find((m) => igual(m.nombre, actual));
    if (conocida && !lista.some((n) => igual(n, conocida.nombre))) lista.push(conocida.nombre);
    lista.sort((a, b) => a.localeCompare(b, 'es'));
    const elegida = conocida ? conocida.nombre : '';
    select.replaceChildren(
      h('option', { value: '', text: lista.length ? '— Elige el fabricante —' : '— Ninguno en el catálogo —' }),
      ...lista.map((n) => h('option', { value: n, text: n, selected: n === elegida })),
      h('option', { value: OTRA_MARCA, text: 'Otro fabricante…', selected: Boolean(actual && !conocida) }),
    );
    if (actual && !conocida) otra.value = actual;
    otra.hidden = select.value !== OTRA_MARCA;
    ayuda.textContent = `${lista.length ? `Los de ${nombreTipo.toLowerCase()}` : 'Aún no hay ninguno para este tipo'} (se cambian en Admin › Catálogo).`;
  }
  return { select, otra, ayuda, valor, opciones };
}

/** Propone lo que ya hay de ese fabricante (modelos, referencias, colores y tallas) sin impedir escribir otra cosa. */
function sugeridor(entradas) {
  const listas = Object.fromEntries(Object.entries(entradas).map(([k, input]) => {
    const lista = h('datalist', { id: `alta-sug-${k}` });
    input.setAttribute('list', lista.id);
    return [k, lista];
  }));
  let vez = 0;
  let espera = 0;
  async function pedir(filtro) {
    const esta = ++vez;
    if (!filtro.marca) {
      Object.values(listas).forEach((l) => l.replaceChildren());
      return;
    }
    const qs = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
    const res = await api('GET', `/api/stock/sugerencias?${qs}`);
    if (esta !== vez || !res.ok) return; // llegó tarde o falló: se queda lo que había
    const valores = { modelo: res.data.modelos, referencia: res.data.referencias, color: res.data.colores, talla: res.data.tallas };
    for (const [k, lista] of Object.entries(listas)) lista.replaceChildren(...(valores[k] ?? []).map((v) => h('option', { value: v })));
  }
  return {
    listas: Object.values(listas),
    actualizar(filtro) {
      clearTimeout(espera);
      espera = setTimeout(() => { pedir(filtro); }, 250);
    },
  };
}

function diferenciasEl(linea, nombre) {
  return h('div', { class: 'alta-dif', role: 'group', 'aria-label': 'Ya existe con otros datos' }, [
    h('p', { class: 'strong', text: `Ya existe (${uds(linea.stock_actual)} en tienda) con otros datos:` }),
    h('ul', {}, linea.diferencias.map((d) => h('li', {}, [h('span', { class: 'strong', text: `${d.etiqueta}: ` }), `${d.actual} → ${d.nuevo}`]))),
    h('div', { class: 'alta-opciones' }, [
      ['actualizar', 'Sumar las unidades y poner los datos nuevos'],
      ['mantener', 'Sumar las unidades y dejar los datos actuales'],
    ].map(([v, t], i) => h('label', { class: 'alta-radio' }, [h('input', { type: 'radio', name: nombre, value: v, checked: i === 0 }), h('span', { text: t })]))),
  ]);
}

/* ---------- Uno a uno ---------- */

function formularioProducto(tipos, marcas, previo) {
  const tipoInicial = tipos.some((t) => t.id === previo.tipo) ? previo.tipo : (tipos.find((t) => t.id === 'calzado') ?? tipos[0])?.id;
  const tipo = h('select', { id: 'alta-tipo' }, tipos.map((t) => h('option', { value: t.id, text: t.nombre, selected: t.id === tipoInicial })));
  const subtipo = h('select', { id: 'alta-subtipo' });
  const marca = campoMarca(marcas, previo.marca);
  const subtipoId = () => tipos.find((t) => t.id === tipo.value)?.subtipos.find((s) => s.nombre === subtipo.value)?.id ?? null;
  const nombreTipo = () => tipos.find((t) => t.id === tipo.value)?.nombre ?? '';
  opcionesSubtipo(subtipo, tipo.value, tipos, previo.subtipo);
  marca.opciones(tipo.value, subtipoId(), nombreTipo());
  const f = {
    modelo: entrada('alta-modelo', previo.modelo, { maxlength: '100', autocomplete: 'off' }),
    referencia: entrada('alta-ref', previo.referencia, { maxlength: '50', required: true, autocomplete: 'off' }),
    talla: entrada('alta-talla', previo.talla, { maxlength: '10', autocomplete: 'off' }),
    color: entrada('alta-color', previo.color, { maxlength: '50', autocomplete: 'off' }),
    coste: entrada('alta-coste', previo.coste, { inputmode: 'decimal', placeholder: '0,00' }),
    pvp: entrada('alta-pvp', previo.pvp, { inputmode: 'decimal', placeholder: '0,00' }),
    unidades: entrada('alta-uds', previo.unidades ?? '1', { inputmode: 'numeric', required: true }),
    codigo: entrada('alta-codigo', previo.codigo, { inputmode: 'numeric', maxlength: '14', class: 'mono', placeholder: 'Vacío = se genera uno' }),
    detalle: h('textarea', { id: 'alta-detalle', rows: '2', maxlength: '200', text: previo.detalle ?? '' }),
  };
  const otra = h('input', { type: 'checkbox', checked: previo.otra ?? true });
  const aviso = h('div', { 'aria-live': 'polite' });
  let pendiente = null; // fila revisada que ya existe con otros datos

  // Lo que se ofrece depende de lo elegido: tipo → subtipos y fabricantes;
  // fabricante, modelo y referencia → lo que ya hay de ellos en el inventario.
  const sug = sugeridor({ modelo: f.modelo, referencia: f.referencia, color: f.color, talla: f.talla });
  const pedirSugerencias = () => sug.actualizar({ marca: marca.valor(), tipo: tipo.value, modelo: f.modelo.value.trim(), referencia: f.referencia.value.trim() });
  tipo.addEventListener('change', () => {
    opcionesSubtipo(subtipo, tipo.value, tipos, null);
    marca.opciones(tipo.value, subtipoId(), nombreTipo());
    pedirSugerencias();
  });
  subtipo.addEventListener('change', () => marca.opciones(tipo.value, subtipoId(), nombreTipo()));
  marca.select.addEventListener('change', pedirSugerencias);
  marca.otra.addEventListener('input', pedirSugerencias);
  f.modelo.addEventListener('change', pedirSugerencias);
  f.referencia.addEventListener('change', pedirSugerencias);
  pedirSugerencias();

  const leer = () => ({
    tipo: tipo.value, subtipo: subtipo.value, marca: marca.valor(), ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()])),
  });
  return openDialog({
    eyebrow: 'Stock · Inventario',
    title: 'Nuevo producto',
    lead: 'Una talla y un color. Si ya existe igual, se suman sus unidades.',
    content: h('div', { class: 'pform' }, [
      h('div', { class: 'pform-grid' }, [
        campo('alta-tipo', 'Tipo de producto', tipo),
        campo('alta-subtipo', 'Subtipo', subtipo),
        h('div', { class: 'pfield' }, [
          h('label', { for: 'alta-marca', text: 'Fabricante' }), marca.select, marca.otra, marca.ayuda,
        ]),
        campo('alta-modelo', 'Modelo', f.modelo, 'Vacío = la referencia'),
        campo('alta-ref', 'Referencia', f.referencia),
        campo('alta-talla', 'Talla', f.talla, 'Vacía = talla única'),
        campo('alta-color', 'Color', f.color),
        campo('alta-coste', 'Precio coste €', f.coste),
        campo('alta-pvp', 'PVP €', f.pvp),
        campo('alta-uds', 'Unidades', f.unidades, 'Las que hay en la tienda'),
        campo('alta-codigo', 'Código de barras', f.codigo, 'Un 200… de una etiqueta antigua se conserva; el de la caja se guarda como código de fábrica.', true),
        campo('alta-detalle', 'Detalle', f.detalle, 'Opcional: piel, velcro, cordones…', true),
      ]),
      h('label', { class: 'alta-radio alta-otra' }, [otra, h('span', { text: 'Después, seguir con otra talla de este modelo' })]),
      aviso,
      ...sug.listas,
    ]),
    submitLabel: 'Guardar',
    onSubmit: async (form) => {
      const fila = leer();
      if (!fila.marca) return { error: marca.select.value === OTRA_MARCA ? 'Escribe el nombre del fabricante.' : 'Elige el fabricante.' };
      const clave = JSON.stringify(fila);
      let decisiones = {};
      if (pendiente?.json === clave) {
        decisiones = { [pendiente.linea.clave]: form.querySelector('input[name="alta-decision"]:checked')?.value ?? 'actualizar' };
      } else {
        aviso.replaceChildren();
        pendiente = null;
        const rev = await api('POST', `${API}/revisar`, { filas: [fila] });
        if (!rev.ok) return { error: rev.error };
        if (rev.data.errores.length) return { error: `Revisa: ${rev.data.errores[0].errores.join('; ')}.` };
        const [linea] = rev.data.lineas;
        if (linea.estado === 'conflicto') {
          pendiente = { json: clave, linea };
          aviso.replaceChildren(diferenciasEl(linea, 'alta-decision'));
          return { stay: true };
        }
      }
      const res = await api('POST', `${API}/confirmar`, { filas: [fila], decisiones, origen: 'manual' });
      if (!res.ok) return { error: res.error };
      return { fila: { ...fila, otra: otra.checked }, ...res.data };
    },
  });
}

/** Da de alta productos uno a uno (con «otra talla» en bucle). Devuelve true si se guardó alguno. */
export async function nuevoProducto(tipos) {
  const hechos = [];
  let previo = {};
  const res = await api('GET', '/api/stock/marcas');
  let marcas = res.ok ? res.data : [];
  if (!res.ok) showToast('No se pudo cargar la lista de fabricantes: elige «Otro» y escríbelo.');
  for (;;) {
    const r = await formularioProducto(tipos, marcas, previo);
    if (!r?.articulos) break;
    const [a] = r.articulos;
    hechos.push(...r.articulos);
    // Un fabricante nuevo ya está en el catálogo: la próxima vez sale en la lista.
    if (!marcas.some((m) => igual(m.nombre, r.fila.marca))) marcas = [...marcas, { id: 0, nombre: r.fila.marca, ambitos: [{ tipo: r.fila.tipo, subtipo_id: null }] }];
    showToast(a.accion === 'nuevo' ? `Producto creado con ${uds(a.unidades)}` : `Ya existía: +${uds(a.unidades)} (ahora ${a.stock}).`);
    if (!r.fila.otra) break;
    previo = { ...r.fila, talla: '', unidades: '1', codigo: '' };
  }
  if (hechos.length) await ofrecerEtiquetas(hechos);
  return hechos.length > 0;
}

/* ---------- Desde Excel ---------- */

function revisionEl(rev) {
  const { resumen: r, errores, lineas } = rev;
  const chip = (texto, tono) => h('span', { class: `sbadge ${tono}`, text: texto });
  const partes = [h('div', { class: 'alta-resumen' }, [
    chip(`${r.nuevos} nuevos`, 'sb-recibido'),
    chip(`${r.sumar} suman unidades`, 'sb-parcial'),
    r.conflictos ? chip(`${r.conflictos} con datos distintos`, 'sb-pendiente') : null,
    chip(`${uds(r.unidades)} en total`, 'sb-cancelado'),
  ])];
  if (errores.length) {
    partes.push(h('div', { class: 'alta-errores', role: 'alert' }, [
      h('p', { class: 'strong', text: `${errores.length} fila${errores.length === 1 ? '' : 's'} con errores. Corrígelas en el Excel y vuelve a elegirlo: no se importa nada hasta que esté todo bien.` }),
      h('ul', {}, errores.slice(0, MAX_ERRORES).map((e) => h('li', {}, [h('span', { class: 'strong', text: `Fila ${e.fila}: ` }), e.errores.join('; ')]))),
      errores.length > MAX_ERRORES ? h('p', { class: 'pmuted', text: `…y ${errores.length - MAX_ERRORES} más.` }) : null,
    ]));
  }
  const conflictos = lineas.filter((l) => l.estado === 'conflicto');
  if (conflictos.length && !errores.length) {
    const todos = h('select', { class: 'pinput', 'data-todos': '', 'aria-label': 'Decidir para todos' }, [
      h('option', { value: '', text: 'Para todos…' }),
      h('option', { value: 'actualizar', text: 'Poner los datos nuevos' }),
      h('option', { value: 'mantener', text: 'Dejar los datos actuales' }),
      h('option', { value: 'omitir', text: 'No importar' }),
    ]);
    const bloque = h('div', { class: 'alta-conflictos' }, [
      h('div', { class: 'alta-conflictos-head' }, [h('p', { class: 'strong', text: 'Ya existen con otros datos: elige qué hacer con cada uno.' }), todos]),
      h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable' }, [
        h('thead', {}, h('tr', {}, ['Fila', 'Producto', 'En tienda', 'Distinto', 'Qué hacer'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, conflictos.map((l) => h('tr', {}, [
          h('td', { class: 'num', text: l.filas.join(', ') }),
          h('td', {}, [producto(l), h('div', { class: 'pmuted small', text: `${tallaTxt(l.talla)} · +${uds(l.unidades)}` })]),
          h('td', { class: 'num', text: String(l.stock_actual) }),
          h('td', { class: 'small' }, l.diferencias.map((d) => h('div', { text: `${d.etiqueta}: ${d.actual} → ${d.nuevo}` }))),
          h('td', {}, h('select', { class: 'pinput', 'data-decision': l.clave, 'aria-label': `Qué hacer con la fila ${l.filas[0]}` }, [
            h('option', { value: '', text: 'Elegir…' }),
            h('option', { value: 'actualizar', text: 'Sumar y poner los datos nuevos' }),
            h('option', { value: 'mantener', text: 'Sumar y dejar los actuales' }),
            h('option', { value: 'omitir', text: 'No importar' }),
          ])),
        ]))),
      ])),
    ]);
    partes.push(bloque);
    todos.addEventListener('change', () => {
      if (!todos.value) return;
      bloque.querySelectorAll('[data-decision]').forEach((s) => { s.value = todos.value; });
    });
  }
  if (lineas.length) {
    partes.push(h('details', { class: 'alta-detalle' }, [
      h('summary', { text: `Ver los ${lineas.length} productos` }),
      h('div', { class: 'ptable-wrap' }, h('table', { class: 'ptable' }, [
        h('thead', {}, h('tr', {}, ['Fila', 'Producto', 'Talla', 'Uds.', 'Coste', 'PVP', 'Qué pasa'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, lineas.slice(0, MAX_LINEAS).map((l) => h('tr', {}, [
          h('td', { class: 'num', text: l.filas.join(', ') }),
          h('td', { text: producto(l) }),
          h('td', { text: l.talla }),
          h('td', { class: 'num', text: String(l.unidades) }),
          h('td', { class: 'num', text: l.coste_cent == null ? '—' : eur(l.coste_cent) }),
          h('td', { class: 'num', text: l.pvp_cent == null ? '—' : eur(l.pvp_cent) }),
          h('td', { class: 'small', text: { nuevo: 'Nuevo', sumar: `Suma a ${l.stock_actual}`, conflicto: 'Datos distintos' }[l.estado] }),
        ]))),
      ])),
      lineas.length > MAX_LINEAS ? h('p', { class: 'pmuted', text: `Se muestran ${MAX_LINEAS}; se importan todos.` }) : null,
    ]));
  }
  return h('div', { class: 'alta-revision' }, partes);
}

/** Importa productos desde un Excel. Devuelve true si se importó algo. */
export async function importarExcel() {
  const archivo = h('input', { id: 'alta-excel', type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const zona = h('div', { 'aria-live': 'polite' });
  let lista = null; // { filas, revision } del último Excel revisado
  archivo.addEventListener('change', () => { lista = null; zona.replaceChildren(); });
  const pintar = (form, revision) => {
    zona.replaceChildren(revisionEl(revision));
    const listo = !revision.errores.length && revision.lineas.length;
    form.querySelector('button[type="submit"] span').textContent = listo ? `Importar ${uds(revision.resumen.unidades)}` : 'Revisar el Excel';
  };
  const hecho = await openDialog({
    eyebrow: 'Stock · Inventario',
    title: 'Importar desde Excel',
    lead: 'Una fila por talla y color. Primero se revisa; no se guarda nada hasta que lo confirmes.',
    content: h('div', { class: 'pform alta-excel' }, [
      h('p', {}, [
        'Columnas: tipo de producto, fabricante, modelo, referencia, talla, color, precio coste, PVP, unidades y código de barras (y, si quieres, subtipo y detalle). ',
        h('a', { href: `${API}/plantilla.xlsx`, download: 'plantilla-inventario.xlsx', text: 'Descargar la plantilla' }),
      ]),
      campo('alta-excel', 'Archivo Excel (.xlsx)', archivo),
      zona,
    ]),
    submitLabel: 'Revisar el Excel',
    onSubmit: async (form) => {
      const file = archivo.files?.[0];
      if (!file) return { error: 'Elige el archivo Excel.' };
      if (!lista || lista.revision.errores.length) {
        const res = await subir(`${API}/excel`, file);
        if (!res.ok) return { error: res.error };
        lista = res.data;
        pintar(form, lista.revision);
        return lista.revision.errores.length ? { error: 'Hay filas con errores (abajo).' } : { stay: true };
      }
      const selects = [...form.querySelectorAll('[data-decision]')];
      if (selects.some((s) => !s.value)) return { error: 'Elige qué hacer con cada producto que ya existe con otros datos.' };
      const decisiones = Object.fromEntries(selects.map((s) => [s.dataset.decision, s.value]));
      const res = await api('POST', `${API}/confirmar`, { filas: lista.filas, decisiones, origen: 'excel' });
      if (!res.ok) {
        // Algo cambió desde la revisión (otra persona dio de alta lo mismo): se vuelve a revisar.
        if (res.data?.lineas) {
          lista = { ...lista, revision: res.data };
          pintar(form, res.data);
        }
        return { error: res.error };
      }
      return res.data;
    },
  });
  if (!hecho?.resumen) return Boolean(hecho);
  const r = hecho.resumen;
  showToast(`Importado: ${r.nuevos} nuevos y ${r.sumados} con unidades sumadas (${uds(r.unidades)})`);
  await ofrecerEtiquetas(hecho.articulos);
  return true;
}

/* ---------- Etiquetas ---------- */

const MAX_ETIQUETAS = 5000; // las que caben en un PDF (el servidor no hace más de una vez)

/** Parte la lista en PDFs de como mucho MAX_ETIQUETAS (un artículo con muchas copias se reparte). */
function enPartes(lista) {
  const partes = [[]];
  let enEsta = 0;
  for (const a of lista) {
    let quedan = a.copias;
    while (quedan > 0) {
      if (enEsta === MAX_ETIQUETAS) {
        partes.push([]);
        enEsta = 0;
      }
      const n = Math.min(quedan, MAX_ETIQUETAS - enEsta);
      partes.at(-1).push({ id: a.id, copias: n });
      enEsta += n;
      quedan -= n;
    }
  }
  return partes;
}

/** Abre un PDF de etiquetas (la ventana se abre ya, con el clic, para que el navegador no la bloquee). */
async function abrirEtiquetas(lista) {
  const ventana = window.open('', '_blank');
  let res;
  try {
    res = await fetch(`${API}/etiquetas.pdf`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articulos: lista }),
    });
  } catch {
    ventana?.close();
    return { error: 'No hay conexión con el servidor. Inténtalo de nuevo.' };
  }
  if (!res.ok) {
    ventana?.close();
    return { error: (await res.json().catch(() => null))?.error ?? 'No se pudieron generar las etiquetas.' };
  }
  const url = URL.createObjectURL(await res.blob());
  if (ventana) ventana.location.href = url;
  else h('a', { href: url, download: 'etiquetas.pdf' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

async function ofrecerEtiquetas(articulos) {
  const lista = articulos.filter((a) => a.unidades > 0).map((a) => ({ id: a.id, copias: a.unidades }));
  const total = lista.reduce((s, a) => s + a.copias, 0);
  if (!total) return;
  const partes = enPartes(lista);
  const varias = partes.length > 1;
  const aviso = h('p', { class: 'alert', role: 'alert', hidden: true });
  const botones = varias ? h('div', { class: 'pbtn-row' }, partes.map((p, i) => {
    const b = h('button', { type: 'button', class: 'pbtn', text: `Parte ${i + 1} (${p.reduce((s, x) => s + x.copias, 0)})` });
    b.addEventListener('click', async () => {
      const r = await abrirEtiquetas(p);
      aviso.hidden = !r?.error;
      aviso.textContent = r?.error ?? '';
      if (!r?.error) b.classList.add('pbtn-ghost');
    });
    return b;
  })) : null;
  await openDialog({
    eyebrow: 'Etiquetas',
    title: `¿Imprimir ${total === 1 ? 'la etiqueta' : `las ${total} etiquetas`}?`,
    lead: varias
      ? `Son muchas para un solo PDF: van en ${partes.length} partes. Abre cada una e imprímela.`
      : 'Una por unidad, con su código de barras (50 × 25 mm). También se pueden imprimir luego con «Etiqueta» en cada fila del inventario.',
    content: varias ? [botones, aviso] : [],
    submitLabel: varias ? 'Hecho' : 'Abrir las etiquetas',
    cancelLabel: varias ? null : 'Ahora no',
    onSubmit: async () => (varias ? true : abrirEtiquetas(partes[0])),
  });
}
