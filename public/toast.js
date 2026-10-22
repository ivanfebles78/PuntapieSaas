const TOAST_MS = 3200;

const toast = document.querySelector('[data-shell-toast]');
let timer = 0;

/** Aviso flotante breve; `tone` puede ser 'error' para los fallos. */
export function showToast(message, { tone = 'info' } = {}) {
  toast.textContent = message;
  toast.classList.toggle('is-error', tone === 'error');
  toast.classList.remove('is-on');
  void toast.offsetWidth;
  toast.classList.add('is-on');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('is-on'), TOAST_MS);
}
