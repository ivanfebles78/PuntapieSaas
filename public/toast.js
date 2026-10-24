const TOAST_MS = 3200;

const toast = document.querySelector('[data-shell-toast]');
const home = toast.parentElement;
let timer = 0;

/** Aviso flotante breve; `tone` puede ser 'error' para los fallos. */
export function showToast(message, { tone = 'info' } = {}) {
  // Con una ventana abierta, el aviso va dentro de ella: si no, queda tapado
  // detrás del fondo de la ventana y no se ve.
  const host = [...document.querySelectorAll('dialog[open]')].at(-1) ?? home;
  if (toast.parentElement !== host) host.append(toast);
  toast.textContent = message;
  toast.classList.toggle('is-error', tone === 'error');
  toast.classList.remove('is-on');
  void toast.offsetWidth;
  toast.classList.add('is-on');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('is-on'), TOAST_MS);
}
