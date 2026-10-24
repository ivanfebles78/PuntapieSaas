import { h } from './dom.js';
import { formatBytes } from './format.js';
import { icon } from './icons.js';

// Foto (o archivo) de la factura al dar de alta un gasto (de cualquier tipo). En un
// móvil, «Hacer foto» abre la cámara trasera; en el ordenador abre el selector.

const MAX_SIDE = 2000; // px: de sobra para leer una factura
const COMPRESS_FROM_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.82;
const ACCEPT = '.pdf,application/pdf,image/jpeg,image/png,image/webp,image/heic';

/**
 * Reduce una foto grande a JPEG de 2.000 px como máximo (las del móvil pesan
 * mucho). Si el navegador no puede leerla (p. ej. HEIC fuera de Safari), se
 * sube tal cual.
 */
async function shrink(file) {
  if (!file.type.startsWith('image/') || file.size < COMPRESS_FROM_BYTES || !('createImageBitmap' in window)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') || 'factura';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** Selector de la factura: «Hacer foto» + «Subir archivo» y la lista de lo elegido. */
export function invoicePicker() {
  let files = [];
  const list = h('ul', { class: 'photo-list', 'aria-live': 'polite' });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const picker = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });

  const render = () => {
    list.replaceChildren(...files.map((f, i) => h('li', { class: 'photo-item' }, [
      icon(f.type === 'application/pdf' ? 'receipt' : 'docDown', 'ico ico-xs'),
      h('span', { class: 'photo-name', text: f.name }),
      h('small', { text: formatBytes(f.size) }),
      h('button', { type: 'button', class: 'file-remove', 'data-photo-remove': String(i), 'aria-label': `Quitar ${f.name}` }, icon('close', 'ico ico-xs')),
    ])));
  };
  const add = async (input) => {
    const chosen = await Promise.all([...input.files].map(shrink));
    files = [...files, ...chosen];
    input.value = '';
    render();
  };
  camera.addEventListener('change', () => add(camera));
  picker.addEventListener('change', () => add(picker));

  const node = h('div', { class: 'field photo-field' }, [
    h('span', { class: 'photo-label', text: 'Factura o ticket (opcional)' }),
    h('div', { class: 'photo-actions' }, [
      h('button', { type: 'button', class: 'btn-chip photo-btn', 'data-photo': 'camera' }, [icon('camera', 'ico ico-xs'), h('span', { text: 'Hacer foto' })]),
      h('button', { type: 'button', class: 'btn-chip photo-btn is-soft', 'data-photo': 'file' }, [icon('receipt', 'ico ico-xs'), h('span', { text: 'Subir archivo' })]),
    ]),
    list,
    h('p', { class: 'field-hint', text: 'Foto con la cámara del móvil, o una foto o PDF que ya tengas. Se guarda como factura del gasto.' }),
    camera,
    picker,
  ]);
  node.addEventListener('click', (event) => {
    const which = event.target.closest('[data-photo]')?.dataset.photo;
    if (which) (which === 'camera' ? camera : picker).click();
    const remove = event.target.closest('[data-photo-remove]');
    if (remove) {
      files = files.filter((_, i) => i !== Number(remove.dataset.photoRemove));
      render();
    }
  });

  return { node, files: () => files };
}

/** Sube las facturas de un gasto recién creado. Devuelve cuántas fallaron. */
export async function uploadInvoices(expenseId, month, files) {
  let failed = 0;
  for (const file of files) {
    try {
      const res = await fetch(`/api/gastos/${expenseId}/archivos?mes=${month}&tipo=factura`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
      if (!res.ok) failed += 1;
    } catch {
      failed += 1;
    }
  }
  return failed;
}
