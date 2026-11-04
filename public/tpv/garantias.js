import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { eurToCent } from '../proveedores/util.js';
import { showToast } from '../toast.js';

// TPV › Garantías: lo devuelto como defectuoso. Está en cuarentena (no se
// vende) hasta que el proveedor responde. Quien vende añade las fotos y
// apunta la reclamación; un Administrador la resuelve con lo que diga el
// proveedor (abono, sustitución, reembolso, rechazo o, si al final se puede
// vender, vuelve al stock).

const ESTADOS = Object.freeze({ abierta: 'En cuarentena', reclamada: 'Reclamada al proveedor', resuelta: 'Resuelta' });
const FILTROS = Object.freeze([['pendientes', 'Pendientes'], ['resueltas', 'Resueltas'], ['todas', 'Todas']]);
const ACEPTA = 'image/*,application/pdf';

const campo = (id, label, control) => h('div', { class: 'field' }, [h('label', { for: id, text: label }), control]);

function selectProveedor(id, proveedores, actual) {
  return h('select', { id }, [
    h('option', { value: '', text: '— Sin proveedor —' }),
    ...proveedores.map((p) => h('option', { value: String(p.id), text: p.nombre, selected: p.id === actual })),
  ]);
}

function editar(inc, proveedores) {
  const defecto = h('textarea', { id: 'gr-def', rows: '3', maxlength: '300', text: inc.defecto });
  const prov = selectProveedor('gr-prov', proveedores, inc.proveedor_id);
  return openDialog({
    eyebrow: `Incidencia ${inc.id}`, title: inc.descripcion, submitLabel: 'Guardar',
    content: [campo('gr-def', 'Defecto', defecto), campo('gr-prov', 'Proveedor', prov)],
    onSubmit: async () => {
      const r = await api('PATCH', `/api/garantias/${inc.id}`, { defecto: defecto.value, proveedor_id: prov.value || null });
      return r.ok ? true : { error: r.error };
    },
  });
}

function reclamar(inc, proveedores) {
  const prov = selectProveedor('gr-rprov', proveedores, inc.proveedor_id);
  const ref = h('input', { id: 'gr-ref', maxlength: '60', autocomplete: 'off' });
  const notas = h('textarea', { id: 'gr-notas', rows: '2', maxlength: '300' });
  return openDialog({
    eyebrow: `Incidencia ${inc.id}`, title: 'Reclamar al proveedor',
    lead: 'Apunta cuándo y a quién se ha reclamado (por correo, en su web…). Si te dan un número de reclamación o RMA, escríbelo.',
    submitLabel: 'Marcar como reclamada',
    content: [campo('gr-rprov', 'Proveedor', prov), campo('gr-ref', 'Nº de reclamación o RMA (si lo hay)', ref), campo('gr-notas', 'Notas', notas)],
    onSubmit: async () => {
      if (!prov.value) return { error: 'Elige a qué proveedor se reclama.' };
      const r = await api('POST', `/api/garantias/${inc.id}/reclamar`, { proveedor_id: prov.value, referencia: ref.value, notas: notas.value });
      return r.ok ? true : { error: r.error };
    },
  });
}

function resolver(inc, resoluciones) {
  const tipo = h('select', { id: 'gr-res' }, [
    h('option', { value: '', text: '— Elige —' }),
    ...Object.entries(resoluciones).map(([id, texto]) => h('option', { value: id, text: texto })),
  ]);
  const importe = h('input', { id: 'gr-imp', inputmode: 'decimal', autocomplete: 'off' });
  const zonaImporte = campo('gr-imp', 'Importe (€)', importe);
  zonaImporte.hidden = true;
  tipo.addEventListener('change', () => { zonaImporte.hidden = !['abono', 'reembolso'].includes(tipo.value); });
  const notas = h('textarea', { id: 'gr-rnotas', rows: '2', maxlength: '300' });
  return openDialog({
    eyebrow: `Incidencia ${inc.id}`, title: 'Resolver con la respuesta del proveedor',
    lead: `${inc.cantidad} × ${inc.descripcion}. Con «Sustitución» o «Se puede vender», ${inc.cantidad === 1 ? 'la unidad vuelve' : 'las unidades vuelven'} al stock.`,
    submitLabel: 'Resolver',
    content: [campo('gr-res', 'Resolución', tipo), zonaImporte, campo('gr-rnotas', 'Notas', notas)],
    onSubmit: async () => {
      if (!tipo.value) return { error: 'Elige cómo se ha resuelto.' };
      const cent = zonaImporte.hidden ? null : eurToCent(importe.value);
      if (!zonaImporte.hidden && !cent) return { error: 'Escribe el importe, por ejemplo 39,95.' };
      const r = await api('POST', `/api/garantias/${inc.id}/resolver`, { resolucion: tipo.value, importe_cent: cent, notas: notas.value });
      return r.ok ? true : { error: r.error };
    },
  });
}

async function subir(inc, files) {
  for (const file of files) {
    let res;
    try {
      res = await fetch(`/api/garantias/${inc.id}/archivos`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      return void showToast('No hay conexión con el servidor. Inténtalo de nuevo.', { tone: 'error' });
    }
    const json = await res.json().catch(() => ({ ok: false, error: 'No se pudo subir el archivo.' }));
    if (!json.ok) return void showToast(`${file.name}: ${json.error}`, { tone: 'error' });
  }
  showToast(files.length === 1 ? 'Archivo añadido.' : `${files.length} archivos añadidos.`);
}

export function renderGarantias(zona, { user, salir, volverCambios }) {
  let filtro = 'pendientes';
  let datos = null;
  const abiertas = new Set();
  const esAdmin = user.role === 'admin';
  const vende = user.role === 'admin' || user.role === 'empleado';

  const resumen = h('div', { class: 'gr-resumen' });
  const filtros = h('div', { class: 'cb-modos', role: 'group', 'aria-label': 'Qué incidencias' },
    FILTROS.map(([id, texto]) => h('button', { type: 'button', 'data-filtro': id, text: texto })));
  const lista = h('div', { class: 'gr-lista', 'aria-live': 'polite' });
  const archivo = h('input', { type: 'file', accept: ACEPTA, multiple: true, hidden: true });
  let destinoArchivo = null;

  const raiz = h('div', { class: 'gr' }, [
    h('div', { class: 'vt-barra' }, [
      h('button', { class: 'tpv-ghost', type: 'button', 'data-salir': '', text: '← Inicio' }),
      h('h1', { class: 'gr-titulo', tabindex: '-1', text: 'Garantías' }),
      h('button', { class: 'tpv-ghost', type: 'button', 'data-cambios': '', text: 'Cambios y devoluciones' }),
    ]),
    h('p', { class: 'cj-ayuda', text: 'Lo devuelto como defectuoso queda aquí, en cuarentena (no se vende), hasta que responda el proveedor. Lo que se le dio al cliente ya está en su devolución.' }),
    h('div', { class: 'cb-barra2' }, [filtros, resumen]),
    lista, archivo,
  ]);

  const tarjeta = (inc) => {
    const abierta = abiertas.has(inc.id);
    const pendiente = inc.estado !== 'resuelta';
    return h('article', { class: `gr-inc is-${inc.estado}` }, [
      h('button', { type: 'button', class: 'gr-inc-cab', 'data-abrir': String(inc.id), 'aria-expanded': String(abierta) }, [
        h('span', { class: 'gr-badge', text: ESTADOS[inc.estado] }),
        h('strong', { text: `${inc.cantidad} × ${inc.descripcion}${inc.talla && inc.talla !== 'Única' ? ` · T. ${inc.talla}` : ''}` }),
        h('span', { class: 'gr-def', text: inc.defecto }),
        h('span', { class: 'gr-meta', text: [
          `Nº ${inc.id}`, inc.fecha, pendiente ? `hace ${inc.dias} ${inc.dias === 1 ? 'día' : 'días'}` : null,
          inc.proveedor ?? 'sin proveedor', inc.rectificativa, `${inc.archivos} ${inc.archivos === 1 ? 'archivo' : 'archivos'}`,
        ].filter(Boolean).join(' · ') }),
      ]),
      abierta ? h('div', { class: 'gr-det', 'data-det': String(inc.id) }, h('p', { class: 'cj-ayuda', text: 'Cargando…' })) : '',
    ]);
  };

  function detalleDom(inc) {
    const pendiente = inc.estado !== 'resuelta';
    return [
      h('dl', { class: 'gr-dl' }, [
        h('dt', { text: 'Devolución' }), h('dd', { text: `${inc.rectificativa ?? '—'} · ${formatEuros(inc.credito_cent)} · abrió ${inc.abrio ?? '—'}` }),
        inc.codigo ? h('dt', { text: 'Código' }) : '', inc.codigo ? h('dd', { text: inc.codigo }) : '',
        h('dt', { text: 'Reclamación' }),
        h('dd', { text: inc.reclamacion ? [inc.reclamacion.fecha, inc.reclamacion.quien, inc.reclamacion.referencia, inc.reclamacion.notas].filter(Boolean).join(' · ') : 'Sin reclamar' }),
        inc.resolucion ? h('dt', { text: 'Resolución' }) : '',
        inc.resolucion ? h('dd', { text: [inc.resolucion.texto, inc.resolucion.importe_cent ? formatEuros(inc.resolucion.importe_cent) : null, inc.resolucion.fecha, inc.resolucion.quien, inc.resolucion.notas].filter(Boolean).join(' · ') }) : '',
      ]),
      h('div', { class: 'gr-archivos' }, inc.archivos.length ? inc.archivos.map((f) => h('a', {
        class: 'gr-archivo', href: `/api/garantias/archivos/${f.id}`, target: '_blank', rel: 'noopener',
      }, [
        f.tipo.startsWith('image/') ? h('img', { src: `/api/garantias/archivos/${f.id}`, alt: f.nombre, loading: 'lazy', width: '96', height: '96' }) : h('span', { class: 'gr-pdf', text: 'PDF' }),
        h('small', { text: f.nombre }),
      ])) : [h('p', { class: 'cj-ayuda', text: 'Sin fotos todavía.' })]),
      pendiente && vende ? h('div', { class: 'vt-hecha-acciones' }, [
        h('button', { type: 'button', class: 'vt-libre', 'data-subir': String(inc.id), text: 'Añadir fotos' }),
        h('button', { type: 'button', class: 'tpv-ghost', 'data-editar': String(inc.id), text: 'Editar' }),
        h('button', { type: 'button', class: 'tpv-ghost', 'data-reclamar': String(inc.id), text: inc.estado === 'reclamada' ? 'Reclamar otra vez' : 'Reclamar al proveedor' }),
        esAdmin ? h('button', { type: 'button', class: 'vt-libre', 'data-resolver': String(inc.id), text: 'Resolver' }) : '',
      ]) : '',
      pendiente && !esAdmin ? h('p', { class: 'cj-ayuda', text: 'La resuelve un Administrador cuando responda el proveedor.' }) : '',
    ];
  }

  async function cargarDetalle(id) {
    const r = await api('GET', `/api/garantias/${id}`);
    const nodo = lista.querySelector(`[data-det="${id}"]`);
    if (!nodo) return;
    if (!r.ok) return void nodo.replaceChildren(h('p', { class: 'cj-ayuda', text: r.error }));
    nodo.replaceChildren(...detalleDom(r.data));
  }

  function pintar() {
    filtros.querySelectorAll('[data-filtro]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filtro === filtro)));
    if (!datos) return;
    const t = datos.totales;
    resumen.replaceChildren(
      h('span', {}, [h('strong', { text: String(t.en_cuarentena) }), ` ${t.en_cuarentena === 1 ? 'unidad' : 'unidades'} en cuarentena`]),
      h('span', {}, [h('strong', { text: String(t.abiertas) }), ' sin reclamar']),
      h('span', {}, [h('strong', { text: String(t.reclamadas) }), ' reclamadas']),
    );
    lista.replaceChildren(...(datos.items.length ? datos.items.map(tarjeta) : [h('div', { class: 'vt-ayuda' }, [
      h('strong', { text: filtro === 'pendientes' ? 'No hay nada en cuarentena' : 'No hay incidencias' }),
      h('span', { text: 'Al devolver un producto en «Cambios y devoluciones», márcalo como «Defectuoso» y aparecerá aquí.' }),
    ])]));
    abiertas.forEach((id) => { if (datos.items.some((i) => i.id === id)) cargarDetalle(id); });
  }

  async function cargar() {
    const r = await api('GET', `/api/garantias?estado=${filtro}`);
    if (!r.ok) return void lista.replaceChildren(h('div', { class: 'vt-ayuda' }, [h('strong', { text: r.error })]));
    datos = r.data;
    return pintar();
  }

  const porId = (id) => datos.items.find((i) => i.id === Number(id));
  const tras = async (hecho) => { if (hecho) await cargar(); };

  archivo.addEventListener('change', async () => {
    const files = [...archivo.files];
    archivo.value = '';
    if (!files.length || !destinoArchivo) return;
    await subir(destinoArchivo, files);
    await cargar();
  });

  raiz.addEventListener('click', async (e) => {
    const t = e.target;
    const f = t.closest('[data-filtro]');
    if (f) { filtro = f.dataset.filtro; return void cargar(); }
    const ab = t.closest('[data-abrir]');
    if (ab) {
      const id = Number(ab.dataset.abrir);
      if (abiertas.has(id)) abiertas.delete(id);
      else abiertas.add(id);
      return void pintar();
    }
    const s = t.closest('[data-subir]');
    if (s) { destinoArchivo = porId(s.dataset.subir); return void archivo.click(); }
    const ed = t.closest('[data-editar]');
    if (ed) return void tras(await editar(porId(ed.dataset.editar), datos.proveedores));
    const rc = t.closest('[data-reclamar]');
    if (rc) return void tras(await reclamar(porId(rc.dataset.reclamar), datos.proveedores));
    const rs = t.closest('[data-resolver]');
    if (rs) return void tras(await resolver(porId(rs.dataset.resolver), datos.resoluciones));
    if (t.closest('[data-cambios]')) return void volverCambios();
    if (t.closest('[data-salir]')) return void salir();
    return undefined;
  });

  zona.replaceChildren(raiz);
  pintar();
  cargar();
  raiz.querySelector('h1').focus();
  return raiz;
}
