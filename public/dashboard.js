import { renderUsers } from './admin-users.js';
import { h, stagger } from './dom.js';
import { icon } from './icons.js';
import { ROLE_LABELS, modulesForRole } from './modules.js';
import { showToast } from './toast.js';

export const APP_ROOT = '/app';

const FOOTSTEPS = 6;
const REVEAL_FALLBACK_MS = 2500;

// Pantallas ya construidas dentro de un módulo: /app/<modulo>/<vista>.
const VIEWS = Object.freeze({ usuarios: renderUsers });

const shell = document.getElementById('shell');
const main = document.getElementById('shell-main');
const crumb = shell.querySelector('[data-shell-crumb]');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let revealObserver = null;
let revealFallback = 0;

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 14) return 'Buenos días';
  if (hour >= 14 && hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

function todayLabel(date = new Date()) {
  const text = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sectionsLabel(module) {
  const n = module.submodules.length;
  return `${n} ${n === 1 ? 'sección' : 'secciones'}`;
}

function firstName(user) {
  return (user.name || user.email).split(' ')[0];
}

function renderUser(user) {
  shell.querySelector('[data-shell-initial]').textContent = firstName(user).charAt(0).toUpperCase();
  shell.querySelector('[data-shell-name]').textContent = firstName(user);
  shell.querySelector('[data-shell-role]').textContent = ROLE_LABELS[user.role] ?? user.role;
}

/* ---------- Efectos ---------- */

// Lo visible al cargar aparece ya; el resto, al entrar en pantalla. Si el
// observador no llega a dispararse (pestaña en segundo plano, navegador
// antiguo), una red de seguridad lo muestra todo: nunca queda contenido oculto.
function observeReveals() {
  revealObserver?.disconnect();
  clearTimeout(revealFallback);
  const targets = [...main.querySelectorAll('[data-reveal]')];
  const reveal = (el) => el.classList.add('is-in');
  if (prefersReducedMotion.matches || !('IntersectionObserver' in window)) {
    targets.forEach(reveal);
    return;
  }
  const fold = window.innerHeight;
  const below = targets.filter((el) => {
    if (el.getBoundingClientRect().top < fold) {
      reveal(el);
      return false;
    }
    return true;
  });
  revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reveal(entry.target);
      revealObserver.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  below.forEach((el) => revealObserver.observe(el));
  revealFallback = setTimeout(() => targets.forEach(reveal), REVEAL_FALLBACK_MS);
}

// Luz que sigue al cursor sobre las tarjetas (una sola escritura por fotograma).
let spotlightFrame = 0;
main.addEventListener('pointermove', (event) => {
  const card = event.target.closest('[data-spotlight]');
  if (!card || event.pointerType === 'touch' || spotlightFrame) return;
  spotlightFrame = requestAnimationFrame(() => {
    spotlightFrame = 0;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  });
});

main.addEventListener('click', (event) => {
  const card = event.target.closest('[data-soon]');
  if (!card) return;
  card.classList.remove('is-poked');
  void card.offsetWidth;
  card.classList.add('is-poked');
  showToast(`«${card.dataset.soon}» llegará muy pronto.`);
});

/* ---------- Piezas ---------- */

function footsteps() {
  return h('div', { class: 'footsteps', 'aria-hidden': 'true' },
    Array.from({ length: FOOTSTEPS }, (_, i) => {
      const step = h('span', { class: `step ${i % 2 ? 'step-r' : 'step-l'}` });
      step.style.setProperty('--s', String(i));
      return step;
    }));
}

function arrowBubble(name = 'arrowRight') {
  return h('span', { class: 'bubble' }, icon(name, 'ico ico-sm'));
}

// Todas las fichas iguales: icono grande, nombre y sus secciones.
function moduleTile(module, index) {
  const subs = h('ul', { class: 'tile-subs', 'aria-label': `Secciones de ${module.name}` },
    module.submodules.map((sub) => h('li', {}, [icon(sub.icon, 'ico ico-xs'), h('span', { text: sub.name })])));

  const core = h('span', { class: 'tile-core', 'data-spotlight': '' }, [
    h('span', { class: 'tile-watermark' }, icon(module.icon, 'ico')),
    module.roles ? h('span', { class: 'pill pill-lock', text: 'Solo Administrador' }) : null,
    h('span', { class: 'tile-icon' }, icon(module.icon, 'ico ico-xl')),
    h('span', { class: 'tile-title', text: module.name }),
    h('span', { class: 'tile-count', text: sectionsLabel(module) }),
    subs,
    arrowBubble(),
  ]);

  return stagger(h('a', {
    class: `tile tone-${module.tone} tile-${module.slug}`,
    href: `${APP_ROOT}/${module.slug}`,
    'data-nav': '',
  }, core), index + 2);
}

function renderHome(user) {
  const modules = modulesForRole(user.role);
  const intro = h('section', { class: 'intro' }, [
    h('div', { class: 'intro-text' }, [
      stagger(h('p', { class: 'eyebrow-pill', text: todayLabel() }), 0),
      stagger(h('h1', { class: 'intro-title', tabindex: '-1' }, [
        h('span', { text: `${greeting()}, ` }),
        h('em', { text: `${firstName(user)}.` }),
      ]), 0),
      stagger(h('p', { class: 'intro-lead', text: 'Todo Puntapié en un solo sitio. ¿Por dónde empezamos hoy?' }), 1),
    ]),
    footsteps(),
  ]);
  const grid = h('nav', { class: 'bento', 'aria-label': 'Módulos' }, modules.map(moduleTile));
  // Una columna por módulo en escritorio: todos a la vista y del mismo tamaño.
  grid.style.setProperty('--modules', String(modules.length));
  main.replaceChildren(intro, grid);
  crumb.textContent = '';
  document.title = 'Inicio · Puntapié';
  return intro.querySelector('h1');
}

// Las secciones listas son enlaces; el resto, botones que avisan de que llegarán.
function subCard(module, sub, index) {
  const content = [
    h('span', { class: 'sub-icon' }, icon(sub.icon, 'ico ico-md')),
    h('span', { class: 'sub-name', text: sub.name }),
    h('span', { class: 'sub-summary', text: sub.summary }),
  ];
  const core = sub.to
    ? h('a', {
      class: 'sub-core',
      href: `${APP_ROOT}/${module.slug}/${sub.to}${sub.query ? `?${sub.query}` : ''}`,
      'data-nav': '',
      'data-spotlight': '',
    }, content)
    : h('button', { class: 'sub-core', type: 'button', 'data-soon': sub.name, 'data-spotlight': '' },
      [...content, h('span', { class: 'pill pill-soon' }, [icon('magic', 'ico ico-xs'), h('span', { text: 'Próximamente' })])]);
  return stagger(h('li', { class: 'sub' }, core), index + 2);
}

function renderModule(module) {
  const header = h('header', { class: `module-head tone-${module.tone}` }, [
    stagger(h('a', { class: 'back', href: APP_ROOT, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Todos los módulos' }),
    ]), 0),
    h('div', { class: 'module-title-row' }, [
      stagger(h('span', { class: 'module-icon' }, h('span', { class: 'tile-icon' }, icon(module.icon, 'ico ico-xl'))), 0),
      h('div', {}, [
        stagger(h('p', { class: 'eyebrow-pill', text: `Módulo · ${sectionsLabel(module)}` }), 1),
        stagger(h('h1', { class: 'module-title', tabindex: '-1', text: module.name }), 1),
        stagger(h('p', { class: 'module-summary', text: module.summary }), 2),
      ]),
    ]),
  ]);
  const list = h('ul', { class: `sub-grid tone-${module.tone}`, 'aria-label': `Secciones de ${module.name}` },
    module.submodules.map((sub, i) => subCard(module, sub, i)));
  main.replaceChildren(header, list);
  crumb.textContent = module.name;
  document.title = `${module.name} · Puntapié`;
  return header.querySelector('h1');
}

/* ---------- API pública ---------- */

/**
 * Pinta la pantalla de la ruta /app[/modulo] y devuelve la ruta canónica
 * (/app si el módulo no existe o el rol no puede verlo).
 */
export function renderShell(user, path) {
  renderUser(user);
  const url = new URL(path, location.origin);
  const [slug, viewSlug] = url.pathname.slice(APP_ROOT.length).replace(/^\/+|\/+$/g, '').split('/');
  const module = slug ? modulesForRole(user.role).find((m) => m.slug === slug) : null;
  const hasView = module && module.submodules.some((sub) => sub.to === viewSlug) && VIEWS[viewSlug];

  let heading;
  let canonical = APP_ROOT;
  if (hasView) {
    crumb.textContent = module.name;
    heading = VIEWS[viewSlug]({ main, user, module, params: url.searchParams, backHref: `${APP_ROOT}/${module.slug}` });
    canonical = `${APP_ROOT}/${module.slug}/${viewSlug}`;
  } else if (module) {
    heading = renderModule(module);
    canonical = `${APP_ROOT}/${module.slug}`;
  } else {
    heading = renderHome(user);
  }
  shell.hidden = false;
  window.scrollTo({ top: 0 });
  observeReveals();
  heading.focus({ preventScroll: true });
  return canonical;
}

export function hideShell() {
  shell.hidden = true;
  revealObserver?.disconnect();
  clearTimeout(revealFallback);
  main.replaceChildren();
}

shell.querySelector('[data-shell-logout-icon]').replaceWith(icon('logout', 'ico ico-sm'));
