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
 * abierto con el mensaje, o cualquier otro valor para cerrarlo y resolver con él.
 * Resuelve null si se cancela.
 */
export function openDialog({ eyebrow, title, lead, content = [], submitLabel, tone = 'default', onSubmit, cancelLabel = 'Cancelar' }) {
  return new Promise((resolve) => {
    const alert = h('p', { class: 'alert', role: 'alert', hidden: true });
    const submit = h('button', { class: `btn btn-dialog${tone === 'danger' ? ' btn-danger' : ''}`, type: 'submit' },
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

    let result = null;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    close.addEventListener('click', () => finish(null));
    form.querySelector('[data-cancel]')?.addEventListener('click', () => finish(null));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(null);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.getAttribute('aria-busy') === 'true') return;
      alert.hidden = true;
      submit.setAttribute('aria-busy', 'true');
      try {
        const outcome = await onSubmit(form);
        if (outcome?.error) {
          alert.textContent = outcome.error;
          alert.hidden = false;
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
