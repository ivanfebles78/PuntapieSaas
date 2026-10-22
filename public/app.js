import { APP_ROOT, hideShell, renderShell } from './dashboard.js';

const ROUTES = Object.freeze({ login: '/', forgot: '/recuperar', reset: '/restablecer' });
const VIEW_IDS = ['login', 'forgot', 'sent', 'reset', 'invalid', 'done'];
const MIN_PASSWORD_LENGTH = 8;
const NETWORK_ERROR = 'No hay conexión con el servidor. Inténtalo de nuevo.';

const $ = (selector, root = document) => root.querySelector(selector);
const views = Object.fromEntries(VIEW_IDS.map((id) => [id, $(`#view-${id}`)]));
const landing = $('.landing');

let resetToken = '';
let currentUser = null;

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  const json = await response.json().catch(() => ({ ok: false, error: NETWORK_ERROR }));
  return { status: response.status, ...json };
}

function show(name, { focus = true } = {}) {
  hideShell();
  landing.hidden = false;
  document.title = 'Puntapié · Gestión';
  for (const [id, el] of Object.entries(views)) {
    el.hidden = id !== name;
  }
  const view = views[name];
  hideAlert(view);
  if (focus) {
    const target = view.querySelector('input') ?? view.querySelector('h1');
    if (target === view.querySelector('h1')) target.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
  }
}

function navigate(name, path) {
  if (path && location.pathname + location.search !== path) {
    history.pushState({ view: name }, '', path);
  }
  show(name);
}

function showAlert(view, message) {
  const alert = view.querySelector('.alert');
  if (!alert) return;
  alert.textContent = message;
  alert.hidden = false;
  // Reinicia la animación aunque el mensaje se repita.
  alert.classList.remove('alert');
  void alert.offsetWidth;
  alert.classList.add('alert');
}

function hideAlert(view) {
  const alert = view.querySelector('.alert');
  if (alert) alert.hidden = true;
  view.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

async function withBusy(form, task) {
  const button = form.querySelector('button[type="submit"]');
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try {
    await task();
  } finally {
    button.removeAttribute('aria-busy');
  }
}

function markInvalid(input, view, message) {
  input.setAttribute('aria-invalid', 'true');
  showAlert(view, message);
  input.focus();
}

/* ---------- Mostrar / ocultar contraseña ---------- */

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('.eye');
  if (!toggle) return;
  const input = document.getElementById(toggle.dataset.toggle);
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
  input.focus({ preventScroll: true });
  const end = input.value.length;
  input.setSelectionRange(end, end);
});

function resetPasswordVisibility(form) {
  form.querySelectorAll('.eye').forEach((toggle) => {
    document.getElementById(toggle.dataset.toggle).type = 'password';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', 'Mostrar contraseña');
  });
}

/* ---------- Navegación interna ---------- */

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-go]');
  if (!link) return;
  event.preventDefault();
  const target = link.dataset.go;
  if (target === 'forgot') {
    const email = $('#login-email').value.trim();
    if (email && !$('#forgot-email').value) $('#forgot-email').value = email;
  }
  navigate(target, ROUTES[target]);
});

window.addEventListener('popstate', () => route());

/* ---------- Iniciar sesión ---------- */

views.login.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = views.login;
  const email = form.email.value.trim();
  const password = form.password.value;
  hideAlert(form);
  if (!email) return markInvalid(form.email, form, 'Escribe tu correo electrónico.');
  if (!password) return markInvalid(form.password, form, 'Escribe tu contraseña.');

  return withBusy(form, async () => {
    const res = await api('POST', '/api/auth/login', { email, password });
    if (!res.ok) {
      form.password.value = '';
      return markInvalid(form.password, form, res.error);
    }
    form.reset();
    resetPasswordVisibility(form);
    enterHome(res.data);
    return undefined;
  });
});

/* ---------- Recuperar contraseña ---------- */

views.forgot.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = views.forgot;
  const email = form.email.value.trim();
  hideAlert(form);
  if (!form.email.checkValidity() || !email) {
    return markInvalid(form.email, form, 'Escribe un correo electrónico válido.');
  }
  return withBusy(form, async () => {
    const res = await api('POST', '/api/auth/forgot-password', { email });
    if (!res.ok) return showAlert(form, res.error);
    $('[data-sent-message]').textContent = res.data.message;
    show('sent');
    return undefined;
  });
});

/* ---------- Nueva contraseña ---------- */

function passwordRules(password, confirmation) {
  return {
    length: password.length >= MIN_PASSWORD_LENGTH,
    mix: /\p{L}/u.test(password) && /\d/.test(password),
    match: password.length > 0 && password === confirmation,
  };
}

function updateRules() {
  const form = views.reset;
  const rules = passwordRules(form.newPassword.value, form.confirmPassword.value);
  form.querySelectorAll('[data-rule]').forEach((li) => {
    li.classList.toggle('is-met', rules[li.dataset.rule]);
  });
  return rules;
}

views.reset.addEventListener('input', updateRules);

views.reset.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = views.reset;
  hideAlert(form);
  const rules = updateRules();
  if (!rules.length) return markInvalid(form.newPassword, form, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  if (!rules.mix) return markInvalid(form.newPassword, form, 'La contraseña debe combinar letras y números.');
  if (!rules.match) return markInvalid(form.confirmPassword, form, 'Las dos contraseñas no coinciden.');

  return withBusy(form, async () => {
    const res = await api('POST', '/api/auth/reset-password', {
      token: resetToken,
      newPassword: form.newPassword.value,
      confirmPassword: form.confirmPassword.value,
    });
    if (res.code === 'RESET_TOKEN_INVALID') return finishReset('invalid');
    if (!res.ok) return showAlert(form, res.error);
    return finishReset('done');
  });
});

function finishReset(view) {
  resetToken = '';
  views.reset.reset();
  resetPasswordVisibility(views.reset);
  updateRules();
  // Quita el token de la barra de direcciones y del historial.
  history.replaceState({ view }, '', ROUTES.login);
  show(view);
}

/* ---------- Sesión ---------- */

function isAppPath(path) {
  return path === APP_ROOT || path.startsWith(`${APP_ROOT}/`);
}

function enterApp(user, path = APP_ROOT, { push = false } = {}) {
  currentUser = user;
  landing.hidden = true;
  const canonical = renderShell(user, isAppPath(path) ? path : APP_ROOT);
  if (push) history.pushState({ app: true }, '', canonical);
  else if (location.pathname !== canonical) history.replaceState({ app: true }, '', canonical);
}

function enterHome(user) {
  enterApp(user, APP_ROOT, { push: location.pathname !== APP_ROOT });
}

// Enlaces internos de la aplicación (mosaico, migas, logo).
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (!link || !currentUser || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  const target = new URL(link.href).pathname;
  if (target !== location.pathname) enterApp(currentUser, target, { push: true });
});

$('[data-logout]').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  currentUser = null;
  navigate('login', ROUTES.login);
});

/* ---------- Arranque ---------- */

async function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/';

  // Navegación atrás/adelante dentro de la app sin volver a pedir la sesión.
  if (currentUser && isAppPath(path)) return enterApp(currentUser, path);

  if (path === ROUTES.reset) {
    resetToken = new URLSearchParams(location.search).get('token') ?? '';
    const res = resetToken ? await api('POST', '/api/auth/reset-password/check', { token: resetToken }) : null;
    return show(res?.ok && res.data.valid ? 'reset' : 'invalid');
  }

  const me = await api('GET', '/api/auth/me');
  if (me.ok) return enterApp(me.data, path);
  currentUser = null;
  if (path === ROUTES.forgot) return show('forgot');
  if (path !== ROUTES.login) history.replaceState({ view: 'login' }, '', ROUTES.login);
  return show('login', { focus: window.matchMedia('(min-width: 960px)').matches });
}

route();
