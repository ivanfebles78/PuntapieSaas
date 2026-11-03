import { h } from '../dom.js';
import { formatEuros } from '../format.js';

// Recuento de monedas y billetes (apertura y arqueo de la caja): una casilla
// por moneda o billete con su subtotal, y el total al momento.

const nombre = (c) => (c < 100 ? `${c} cént.` : formatEuros(c).replace(',00', ''));

/**
 * `denominaciones` en céntimos; `inicial` = { céntimos: piezas }.
 * Devuelve { el, leer(), total() }; `alCambiar(total)` se llama en cada cambio.
 */
export function recuentoDinero(denominaciones, inicial = {}, alCambiar = () => {}) {
  const monedas = denominaciones.filter((d) => d < 500);
  const billetes = denominaciones.filter((d) => d >= 500);
  const casillas = new Map();
  const totalEl = h('strong', { class: 'rc-total-n' });

  function fila(d) {
    const input = h('input', {
      type: 'number', min: '0', max: '100000', inputmode: 'numeric', value: inicial[d] ? String(inicial[d]) : '',
      placeholder: '0', 'aria-label': `Número de ${d < 500 ? 'monedas' : 'billetes'} de ${nombre(d)}`,
    });
    const sub = h('span', { class: 'rc-sub' });
    casillas.set(d, { input, sub });
    return h('label', { class: `rc-fila${d >= 500 ? ' is-billete' : ''}` }, [h('span', { class: 'rc-valor', text: nombre(d) }), input, sub]);
  }

  const leer = () => Object.fromEntries([...casillas].map(([d, c]) => [d, Number(c.input.value) || 0]).filter(([, n]) => n > 0));
  const total = () => Object.entries(leer()).reduce((s, [d, n]) => s + Number(d) * n, 0);

  function actualizar() {
    for (const [d, c] of casillas) {
      const n = Number(c.input.value) || 0;
      c.sub.textContent = n ? formatEuros(d * n) : '';
    }
    totalEl.textContent = formatEuros(total());
    alCambiar(total());
  }

  const el = h('div', { class: 'rc' }, [
    h('div', { class: 'rc-grupo' }, [h('h3', { text: 'Billetes' }), ...billetes.slice().reverse().map(fila)]),
    h('div', { class: 'rc-grupo' }, [h('h3', { text: 'Monedas' }), ...monedas.slice().reverse().map(fila)]),
    h('div', { class: 'rc-total' }, [h('span', { text: 'Total contado' }), totalEl]),
  ]);
  el.addEventListener('input', actualizar);
  // Seleccionar el número al entrar en la casilla: así se sobrescribe al teclear.
  el.addEventListener('focusin', (e) => e.target.select?.());
  queueMicrotask(actualizar);
  return { el, leer, total };
}
