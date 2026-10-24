import { h } from './dom.js';
import { icon } from './icons.js';

/** Campo de formulario con etiqueta y pista opcional. */
export function field({ label, name, type = 'text', value = '', required = false, autocomplete, hint, inputmode }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 8)}`;
  return h('div', { class: 'field' }, [
    h('label', { for: id, text: label }),
    h('input', { id, name, type, value, required, autocomplete, inputmode, spellcheck: 'false' }),
    hint ? h('p', { class: 'field-hint', text: hint }) : null,
  ]);
}

/**
 * Abre un diálogo modal. `onSubmit(form)` devuelve { error } para mantenerlo
 * abierto con el mensaje, { stay: true } para mantenerlo abierto sin error,
 * o cualquier otro valor para cerrarlo y resolver con él.
 * Resuelve null si se cancela (o el último valor de `resultOnClose()`).
 */
export function openDialog({ eyebrow, title, lead, content = [], submitLabel, tone = 'default', onSubmit, cancelLabel = 'Cancelar', allowReadOnly = false }) {
  // Solo consulta (Asesor): todo se ve, nada se puede tocar ni enviar
  // (salvo diálogos que no cambian nada, como exportar).
  const readOnly = !allowReadOnly && document.body.classList.contains('is-readonly');
  if (readOnly) {
    content = h('fieldset', { class: 'readonly-fieldset', disabled: true }, [
      h('p', { class: 'readonly-note' }, [icon('shield', 'ico ico-xs'), h('span', { text: 'Solo consulta' })]),
      ...[].concat(content),
    ]);
    cancelLabel = 'Cerrar';
  }
  return new Promise((resolve) => {
    const alert = h('p', { class: 'alert', role: 'alert', hidden: true });
    const submit = h('button', { class: `btn btn-dialog${tone === 'danger' ? ' btn-danger' : ''}`, type: 'submit', hidden: readOnly },
      h('span', { text: submitLabel }));
    const form = h('form', { class: 'sheet-form', novalidate: true }, [
      h('header', { class: 'sheet-head' }, [
        eyebrow ? h('p', { class: 'eyebrow-pill', text: eyebrow }) : null,
        h('h2', { class: 'sheet-title', text: title }),
        lead ? h('p', { class: 'sheet-lead', text: lead }) : null,
      ]),
      ...[].concat(content),
      alert,
      h('div', { class: 'sheet-actions' }, [
        cancelLabel ? h('button', { class: 'btn-text', type: 'button', 'data-cancel': '', text: cancelLabel }) : null,
        submit,
      ]),
    ]);
    const close = h('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Cerrar' }, icon('close', 'ico ico-sm'));
    const dialog = h('dialog', { class: `sheet sheet-${tone}` }, h('div', { class: 'sheet-core' }, [close, form]));

    // Si hubo cambios con { stay: true }, cerrar devuelve true para que se refresque la vista.
    let result = null;
    let settled = false;
    // Se resuelve al cerrar sin esperar al evento «close» (que el navegador
    // puede retrasar si la página no se está pintando); Escape llega por él.
    const settle = () => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    const finish = (value) => {
      result = value;
      settle();
    };
    const dismiss = () => finish(result);
    dialog.addEventListener('close', settle);
    close.addEventListener('click', dismiss);
    form.querySelector('[data-cancel]')?.addEventListener('click', dismiss);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dismiss();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (readOnly || submit.getAttribute('aria-busy') === 'true') return;
      alert.hidden = true;
      submit.setAttribute('aria-busy', 'true');
      try {
        const outcome = await onSubmit(form);
        if (outcome?.error) {
          alert.textContent = outcome.error;
          alert.hidden = false;
          return;
        }
        if (outcome?.stay) {
          result = true;
          return;
        }
        finish(outcome ?? true);
      } finally {
        submit.removeAttribute('aria-busy');
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    form.querySelector('input')?.focus();
  });
}
