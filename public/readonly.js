import { isReadOnly } from './modules.js';
import { showToast } from './toast.js';

// Modo solo consulta (rol Asesor). El servidor ya rechaza cualquier cambio;
// aquí se esconden los botones que cambian algo y se desactivan los que
// muestran un dato y además lo editan (importe, estado).

const HIDE = [
  '[data-new]',
  '[data-invite]',
  '[data-new-opening]',
  '[data-edit-opening]',
  '[data-delete-opening]',
  '[data-edit-targets]',
  '[data-upload]',
  '[data-remove-file]',
  '.expense [data-action]',
  '.member-actions [data-action]:not([data-action="vacations"]):not([data-action="schedule"])',
].join(', ');

const INERT = '[data-amount], [data-toggle-status]';

export const readOnlyActive = () => document.body.classList.contains('is-readonly');

export function applyReadOnly(user) {
  document.body.classList.toggle('is-readonly', isReadOnly(user));
}

// En captura: el clic no llega a los manejadores de cada pantalla.
document.addEventListener('click', (event) => {
  if (!readOnlyActive()) return;
  const target = event.target.closest(`${HIDE}, ${INERT}`);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  showToast('Tu acceso es de solo consulta.');
}, true);
