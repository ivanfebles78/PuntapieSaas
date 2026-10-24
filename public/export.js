import { openDialog } from './dialogs.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

// Botón y diálogo de exportar a ZIP (Excel + documentos). Exportar no cambia
// nada, así que también lo puede usar el Asesor.

export function exportButton(attrs = {}) {
  return h('button', { class: 'month-today export-btn', type: 'button', 'data-export': '', ...attrs }, [
    icon('docDown', 'ico ico-xs'),
    h('span', { text: 'Exportar' }),
  ]);
}

/** Descarga con la sesión actual (mismo origen), sin abrir otra pestaña. */
export function download(url) {
  const link = h('a', { href: url, download: '' });
  document.body.append(link);
  link.click();
  link.remove();
  showToast('Preparando el ZIP… se descargará en unos segundos.');
}

/**
 * Diálogo para elegir qué se exporta. `options` = [{ id, label, detail, url }];
 * la primera es la marcada por defecto.
 */
export async function chooseExport({ title, lead, options }) {
  const chosen = await openDialog({
    eyebrow: 'Exportar',
    title,
    lead,
    allowReadOnly: true,
    content: h('div', { class: 'export-options', role: 'radiogroup' }, options.map((o, i) => h('label', { class: 'export-option' }, [
      h('input', { type: 'radio', name: 'export', value: o.id, checked: i === 0 }),
      h('span', { class: 'export-option-text' }, [h('strong', { text: o.label }), h('small', { text: o.detail })]),
    ]))),
    submitLabel: 'Descargar ZIP',
    onSubmit: async (form) => options.find((o) => o.id === form.elements.namedItem('export').value),
  });
  if (chosen) download(chosen.url);
}
