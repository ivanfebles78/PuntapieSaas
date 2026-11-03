import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';

// Ficha de un artículo del inventario: tipo, subtipo, modelo, color, detalle y
// código de fábrica. La marca, la referencia y la talla no se cambian aquí
// (son las que dan el código de barras de la etiqueta).

const API = '/api/stock';

const campo = (id, label, control, ayuda, ancho = false) => h('label', { class: `pfield${ancho ? ' pfield-wide' : ''}`, for: id }, [
  h('span', { text: label }),
  control,
  ayuda ? h('small', { class: 'pmuted', text: ayuda }) : null,
]);

function opcionesSubtipo(select, tipo, tipos, actual) {
  const subtipos = tipos.find((t) => t.id === tipo)?.subtipos ?? [];
  select.replaceChildren(
    h('option', { value: '', text: '— Sin subtipo —' }),
    ...subtipos.map((s) => h('option', { value: String(s.id), text: s.nombre, selected: s.id === actual })),
  );
}

/** Abre la ficha; devuelve el artículo guardado o null si se cancela. */
export async function editarArticulo(a, tipos) {
  const tipo = h('select', { id: 'art-tipo', name: 'tipo' }, tipos.map((t) => h('option', { value: t.id, text: t.nombre, selected: t.id === a.tipo })));
  const subtipo = h('select', { id: 'art-subtipo', name: 'subtipo' });
  opcionesSubtipo(subtipo, a.tipo, tipos, a.subtipo_id);
  tipo.addEventListener('change', () => opcionesSubtipo(subtipo, tipo.value, tipos, null));
  const texto = (id, name, value, attrs = {}) => h('input', { id, name, type: 'text', value: value ?? '', ...attrs });
  const modelo = texto('art-modelo', 'modelo', a.modelo, { maxlength: '100' });
  const color = texto('art-color', 'color', a.color, { maxlength: '50' });
  const detalle = h('textarea', { id: 'art-detalle', name: 'detalle', rows: '2', maxlength: '200', text: a.detalle ?? '' });
  const fabrica = texto('art-fabrica', 'codigo_fabricante', a.codigo_fabricante, { inputmode: 'numeric', maxlength: '14', class: 'mono' });
  const talla = a.talla === 'Única' ? 'talla única' : `talla ${a.talla}`;
  return openDialog({
    eyebrow: `${a.marca} · ${a.referencia} · ${talla}`,
    title: 'Ficha del artículo',
    lead: `Código ${a.codigo}. Al cambiar el tipo, la talla tiene que valer para el nuevo.`,
    content: h('div', { class: 'pform pform-grid' }, [
      campo('art-tipo', 'Tipo', tipo),
      campo('art-subtipo', 'Subtipo', subtipo),
      campo('art-modelo', 'Modelo', modelo),
      campo('art-color', 'Color', color),
      campo('art-detalle', 'Detalle', detalle, 'Lo que explica el producto: piel, velcro, cordones…', true),
      campo('art-fabrica', 'Código de fábrica', fabrica, 'Opcional: el de la caja original. Al escanearlo también encuentra este artículo.', true),
    ]),
    submitLabel: 'Guardar',
    onSubmit: async () => {
      const res = await api('PUT', `${API}/articulos/${a.id}`, {
        tipo: tipo.value,
        subtipo_id: subtipo.value ? Number(subtipo.value) : null,
        modelo: modelo.value,
        color: color.value,
        detalle: detalle.value,
        codigo_fabricante: fabrica.value,
      });
      return res.ok ? res.data : { error: res.error };
    },
  });
}
