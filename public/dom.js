/** Crea un elemento con atributos y hijos (el texto siempre vía textContent). */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child) el.append(child);
  }
  return el;
}

// Orden de aparición escalonada (CSSOM: permitido por la CSP, a diferencia de style="").
export function stagger(el, index) {
  el.setAttribute('data-reveal', '');
  el.style.setProperty('--i', String(index));
  return el;
}
