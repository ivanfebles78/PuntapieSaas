import { api } from './api.js';
import { openDialog, field } from './dialogs.js';
import { h, stagger } from './dom.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

const FILTERS = Object.freeze([
  { id: 'todos', label: 'Todos' },
  { id: 'activo', label: 'Activos' },
  { id: 'invitado', label: 'Invitados' },
  { id: 'baja', label: 'De baja' },
]);

const STATUS = Object.freeze({
  activo: { label: 'Activo', tone: 'ok' },
  invitado: { label: 'Invitación pendiente', tone: 'wait' },
  baja: { label: 'De baja', tone: 'off' },
});

const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const DAY_MS = 86400000;

const state = { members: [], roles: [], filter: 'todos', query: '', me: null, els: null };

/* ---------- Utilidades ---------- */

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '·';
}

function since(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'ahora mismo';
  if (diff < 3600000) return relative.format(-Math.round(diff / 60000), 'minute');
  if (diff < DAY_MS) return relative.format(-Math.round(diff / 3600000), 'hour');
  return relative.format(-Math.round(diff / DAY_MS), 'day');
}

/** «2026-08-03» → «03/08/2026». */
function formatDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function vacationBadge(member) {
  if (member.onVacationUntil) {
    return h('span', { class: 'status status-sun', text: `De vacaciones hasta el ${formatDate(member.onVacationUntil)}` });
  }
  if (member.nextVacation) {
    return h('span', { class: 'status status-soft', text: `Vacaciones desde el ${formatDate(member.nextVacation)}` });
  }
  return null;
}

function roleLabel(id) {
  return state.roles.find((role) => role.id === id)?.label ?? id;
}

function matches(member) {
  if (state.filter !== 'todos' && member.status !== state.filter) return false;
  if (!state.query) return true;
  const text = `${member.name} ${member.email ?? ''} ${member.username ?? ''}`.toLowerCase();
  return text.includes(state.query);
}

/* ---------- Cabecera, filtros y búsqueda ---------- */

function header(backHref) {
  const cta = h('button', { class: 'cta', type: 'button', 'data-invite': '' }, [
    h('span', { text: 'Invitar a alguien' }),
    h('span', { class: 'bubble bubble-cta' }, icon('userAdd', 'ico ico-sm')),
  ]);
  return h('header', { class: 'module-head tone-admin users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Admin' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, [
      h('div', {}, [
        stagger(h('p', { class: 'eyebrow-pill', text: 'Admin · Equipo' }), 1),
        stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Usuarios' }), 1),
        stagger(h('p', { class: 'module-summary', text: 'Quién entra en la gestión de Puntapié, con qué rol y desde cuándo.' }), 2),
      ]),
      stagger(cta, 2),
    ]),
  ]);
}

function filterBar() {
  const stats = h('div', { class: 'user-stats', role: 'group', 'aria-label': 'Filtrar por estado' },
    FILTERS.map((f) => h('button', { class: 'stat', type: 'button', 'data-filter': f.id, 'aria-pressed': 'false' }, [
      h('span', { class: 'stat-num', 'data-count': f.id, text: '–' }),
      h('span', { class: 'stat-label', text: f.label }),
    ])));
  const search = h('label', { class: 'search' }, [
    icon('search', 'ico ico-sm'),
    h('span', { class: 'sr-only', text: 'Buscar' }),
    h('input', { type: 'search', placeholder: 'Buscar por nombre, usuario o correo', 'data-search': '', autocomplete: 'off' }),
  ]);
  return stagger(h('div', { class: 'users-toolbar' }, [stats, search]), 3);
}

function renderCounts() {
  const counts = { todos: state.members.length, activo: 0, invitado: 0, baja: 0 };
  state.members.forEach((m) => { counts[m.status] += 1; });
  for (const [id, n] of Object.entries(counts)) {
    state.els.root.querySelector(`[data-count="${id}"]`).textContent = String(n);
  }
  state.els.root.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === state.filter));
  });
}

/* ---------- Filas ---------- */

function roleControl(member, isMe) {
  const select = h('select', {
    class: 'role-select',
    'data-role': String(member.id),
    'aria-label': `Rol de ${member.name}`,
    disabled: isMe || member.status === 'baja',
    title: isMe ? 'No puedes cambiar tu propio rol' : null,
  }, state.roles.map((role) => h('option', { value: role.id, text: role.label })));
  select.value = member.role;
  return h('span', { class: `role-wrap role-${member.role}` }, [icon(member.role === 'admin' ? 'crown' : 'people', 'ico ico-xs'), select]);
}

function statusBlock(member) {
  const status = STATUS[member.status];
  const detail = member.status === 'baja'
    ? `Desde ${since(member.deactivatedAt) ?? '—'}`
    : member.lastLoginAt ? `Último acceso ${since(member.lastLoginAt)}`
      : member.invitedAt ? `Invitado ${since(member.invitedAt)}` : 'Aún no ha entrado';
  return h('span', { class: 'member-status' }, [
    h('span', { class: `status status-${status.tone}`, text: status.label }),
    member.mustChangePassword && member.status === 'activo'
      ? h('span', { class: 'status status-wait', text: 'Debe cambiar la contraseña' }) : null,
    member.status === 'baja' ? null : vacationBadge(member),
    h('span', { class: 'member-when' }, [icon('clock', 'ico ico-xs'), h('span', { text: detail })]),
  ]);
}

function actionButton(action, label, iconName, extraClass = '') {
  return h('button', { class: `act ${extraClass}`, type: 'button', 'data-action': action, title: label, 'aria-label': label }, [
    icon(iconName, 'ico ico-sm'),
    h('span', { class: 'act-label', text: label }),
  ]);
}

function actions(member, isMe) {
  if (member.status === 'baja') return [actionButton('reactivate', 'Reactivar', 'userTick')];
  const list = [actionButton('edit', 'Editar', 'magic'), actionButton('vacations', 'Vacaciones', 'sun')];
  if (!isMe) {
    list.push(member.email
      ? actionButton('access', member.status === 'invitado' ? 'Reenviar invitación' : 'Enviar enlace de contraseña', 'sms')
      : actionButton('temp', 'Contraseña provisional', 'key'));
    list.push(actionButton('deactivate', 'Dar de baja', 'userRemove', 'act-danger'));
  }
  return list;
}

function memberRow(member, index) {
  const isMe = member.id === state.me.id;
  const handle = [member.username ? `@${member.username}` : null, member.email ?? 'Sin correo'].filter(Boolean).join(' · ');
  const row = h('li', { class: `member member-${member.status}`, 'data-id': String(member.id) }, [
    h('span', { class: `avatar avatar-${member.role}`, 'aria-hidden': 'true', text: initials(member.name) }),
    h('span', { class: 'member-id' }, [
      h('span', { class: 'member-name' }, [h('span', { text: member.name }), isMe ? h('span', { class: 'me-tag', text: 'Tú' }) : null]),
      h('span', { class: 'member-handle', text: handle }),
    ]),
    roleControl(member, isMe),
    statusBlock(member),
    h('span', { class: 'member-actions' }, actions(member, isMe)),
  ]);
  row.style.setProperty('--i', String(index));
  return row;
}

function renderList() {
  const visible = state.members.filter(matches);
  const list = state.els.list;
  if (visible.length === 0) {
    list.replaceChildren(h('li', { class: 'member-empty' }, [
      icon('people', 'ico ico-xl'),
      h('p', { text: state.members.length ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay nadie en el equipo.' }),
    ]));
  } else {
    list.replaceChildren(...visible.map(memberRow));
  }
  renderCounts();
}

/* ---------- Datos y acciones ---------- */

async function load() {
  const [members, roles] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/roles')]);
  if (!members.ok || !roles.ok) {
    state.els.list.replaceChildren(h('li', { class: 'member-empty' }, h('p', { text: members.error ?? roles.error })));
    return;
  }
  state.members = members.data;
  state.roles = roles.data;
  renderList();
}

function memberById(id) {
  return state.members.find((m) => m.id === Number(id));
}

function roleCards(selected) {
  return h('fieldset', { class: 'role-cards' }, [
    h('legend', { text: 'Rol' }),
    ...state.roles.map((role) => h('label', { class: `role-card role-${role.id}` }, [
      h('input', { type: 'radio', name: 'role', value: role.id, checked: role.id === selected }),
      h('span', { class: 'role-card-icon' }, icon(role.id === 'admin' ? 'crown' : 'people', 'ico ico-md')),
      h('span', { class: 'role-card-name', text: role.label }),
      h('span', { class: 'role-card-desc', text: role.description }),
    ])),
  ]);
}

function deliveryMessage(data, email) {
  if (!data.mailSent) {
    return {
      text: `Hecho, pero el correo a ${email} no ha salido (¿está configurado el envío?). Puedes reenviarlo desde su fila.`,
      tone: 'error',
    };
  }
  return { text: data.kind === 'invite' ? `Invitación enviada a ${email}.` : `Enlace de contraseña enviado a ${email}.` };
}

async function inviteMember() {
  const data = await openDialog({
    eyebrow: 'Alta',
    title: 'Invitar a alguien',
    lead: 'Recibirá un correo para crear su contraseña. La invitación caduca en 7 días.',
    content: [
      field({ label: 'Nombre', name: 'name', autocomplete: 'off', required: true }),
      field({ label: 'Correo electrónico', name: 'email', type: 'email', inputmode: 'email', autocomplete: 'off', required: true }),
      roleCards('empleado'),
    ],
    submitLabel: 'Enviar invitación',
    onSubmit: async (form) => {
      const res = await api('POST', '/api/admin/users', {
        name: form.elements.namedItem('name').value, email: form.elements.namedItem('email').value, role: form.elements.namedItem('role').value,
      });
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!data) return;
  const message = deliveryMessage(data, data.user.email);
  showToast(message.text, { tone: message.tone });
  await load();
}

async function editMember(member) {
  const saved = await openDialog({
    eyebrow: member.username ? `@${member.username}` : 'Editar',
    title: `Editar a ${member.name}`,
    content: [
      field({ label: 'Nombre', name: 'name', value: member.name, required: true, autocomplete: 'off' }),
      field({
        label: 'Correo electrónico', name: 'email', type: 'email', value: member.email ?? '', inputmode: 'email', autocomplete: 'off',
        hint: member.email ? null : 'Con correo podrá recuperar su contraseña por su cuenta.',
      }),
    ],
    submitLabel: 'Guardar cambios',
    onSubmit: async (form) => {
      const body = { name: form.elements.namedItem('name').value };
      if (form.elements.namedItem('email').value.trim()) body.email = form.elements.namedItem('email').value;
      const res = await api('PATCH', `/api/admin/users/${member.id}`, body);
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!saved) return;
  showToast('Cambios guardados.');
  await load();
}

async function deactivateMember(member) {
  const done = await openDialog({
    eyebrow: 'Baja',
    title: `¿Dar de baja a ${member.name}?`,
    lead: 'Perderá el acceso enseguida y se cerrarán sus sesiones abiertas. Podrás reactivarla cuando quieras.',
    submitLabel: 'Dar de baja',
    tone: 'danger',
    onSubmit: async () => {
      const res = await api('POST', `/api/admin/users/${member.id}/deactivate`);
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!done) return;
  showToast(`${member.name} ya no tiene acceso.`);
  await load();
}

async function temporaryPassword(member) {
  const data = await openDialog({
    eyebrow: 'Contraseña',
    title: 'Contraseña provisional',
    lead: `${member.name} no tiene correo. Generaremos una contraseña provisional que tendrá que cambiar al entrar. Sus sesiones abiertas se cerrarán.`,
    submitLabel: 'Generar',
    onSubmit: async () => {
      const res = await api('POST', `/api/admin/users/${member.id}/temporary-password`);
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!data) return;
  await load();
  await openDialog({
    eyebrow: 'Solo se muestra ahora',
    title: `Contraseña de ${member.name}`,
    lead: `Dísela en persona. Entrará con «${member.username ?? member.email}» y esta contraseña:`,
    content: h('p', { class: 'temp-password', text: data.temporaryPassword }),
    submitLabel: 'Copiar y cerrar',
    cancelLabel: 'Cerrar',
    onSubmit: async () => {
      await navigator.clipboard?.writeText(data.temporaryPassword).catch(() => {});
      showToast('Contraseña copiada.');
      return true;
    },
  });
}

async function simpleAction(member, path, okMessage) {
  const res = await api('POST', `/api/admin/users/${member.id}/${path}`);
  if (!res.ok) {
    showToast(res.error, { tone: 'error' });
    return;
  }
  const message = res.data.kind ? deliveryMessage(res.data, member.email) : { text: okMessage };
  showToast(message.text, { tone: message.tone });
  await load();
}

async function changeRole(select) {
  const member = memberById(select.dataset.role);
  const res = await api('PATCH', `/api/admin/users/${member.id}`, { role: select.value });
  if (!res.ok) {
    select.value = member.role;
    showToast(res.error, { tone: 'error' });
    return;
  }
  showToast(`${member.name} ahora es ${roleLabel(select.value)}.`);
  await load();
}

/* ---------- Vacaciones ---------- */

function vacationItem(vacation) {
  return h('li', { class: 'vac', 'data-vacation': String(vacation.id) }, [
    h('span', { class: 'vac-icon' }, icon('sun', 'ico ico-sm')),
    h('span', { class: 'vac-text' }, [
      h('span', { class: 'vac-range', text: `${formatDate(vacation.start)} → ${formatDate(vacation.end)}` }),
      h('span', { class: 'vac-meta', text: [`${vacation.days} ${vacation.days === 1 ? 'día' : 'días'}`, vacation.note].filter(Boolean).join(' · ') }),
    ]),
    h('button', { class: 'act act-danger', type: 'button', 'data-remove-vacation': String(vacation.id), 'aria-label': 'Borrar periodo', title: 'Borrar periodo' },
      [icon('close', 'ico ico-sm'), h('span', { class: 'act-label', text: 'Borrar' })]),
  ]);
}

const plural = (n, one, many) => `${n} ${Math.abs(n) === 1 ? one : many}`;

function entitledDetail(summary) {
  if (!summary.contractStart) return 'Sin fecha de contrato: año completo';
  if (!summary.prorated) return 'Año completo';
  if (summary.entitled === 0) return `Su contrato empieza el ${formatDate(summary.contractStart)}`;
  return `Proporcional desde el ${formatDate(summary.contractStart)}`;
}

// Saldo del año: corresponden, disfrutados, programados y lo que queda.
function renderSummary(container, summary) {
  const tile = (label, value, detail, extra = '') => h('div', { class: `vac-stat ${extra}` }, [
    h('span', { class: 'vac-stat-num', text: String(value) }),
    h('span', { class: 'vac-stat-label', text: label }),
    detail ? h('span', { class: 'vac-stat-detail', text: detail }) : null,
  ]);
  const left = summary.remaining;
  container.replaceChildren(
    h('p', { class: 'vac-heading', text: `Saldo ${summary.year} · días naturales` }),
    h('div', { class: 'vac-stats' }, [
      tile('Corresponden', summary.entitled, entitledDetail(summary)),
      tile('Disfrutados', summary.taken, 'Hasta hoy'),
      tile('Programados', summary.planned, 'A partir de mañana'),
      tile(left < 0 ? 'Se ha pasado' : 'Quedan', Math.abs(left),
        left < 0 ? plural(-left, 'día de más', 'días de más') : `Hasta el 31/12/${summary.year}`,
        left < 0 ? 'vac-stat-over' : 'vac-stat-left'),
    ]),
  );
}

function renderPeriods(listEl, periods) {
  listEl.replaceChildren(...(periods.length
    ? periods.map(vacationItem)
    : [h('li', { class: 'vac-empty', text: 'Todavía no tiene vacaciones registradas.' })]));
}

function renderOverview(els, overview) {
  renderSummary(els.summary, overview.summary);
  renderPeriods(els.list, overview.periods);
  els.contract.value = overview.contractStart ?? '';
}

async function refreshVacations(member, els) {
  const res = await api('GET', `/api/admin/users/${member.id}/vacations`);
  if (!res.ok) {
    els.list.replaceChildren(h('li', { class: 'vac-empty', text: res.error }));
    return;
  }
  renderOverview(els, res.data);
}

function contractRow() {
  const input = h('input', { type: 'date', name: 'contractStart', id: 'vac-contract', 'aria-describedby': 'vac-contract-hint' });
  const save = h('button', { class: 'btn-chip', type: 'button', 'data-save-contract': '', text: 'Guardar' });
  return {
    input,
    node: h('div', { class: 'field vac-contract' }, [
      h('label', { for: 'vac-contract', text: 'Inicio de contrato' }),
      h('div', { class: 'vac-contract-row' }, [input, save]),
      h('p', { class: 'field-hint', id: 'vac-contract-hint', text: 'Si empezó este año, le corresponde la parte proporcional de los 30 días (redondeando al alza).' }),
    ]),
  };
}

function bindVacationEvents(member, els, root) {
  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-save-contract]')) {
      const res = await api('PUT', `/api/admin/users/${member.id}/contract-start`, { contractStart: els.contract.value || null });
      if (!res.ok) return void showToast(res.error, { tone: 'error' });
      renderOverview(els, res.data);
      return void showToast(res.data.contractStart
        ? `Inicio de contrato: ${formatDate(res.data.contractStart)}. Le corresponden ${plural(res.data.summary.entitled, 'día', 'días')}.`
        : 'Fecha de contrato borrada.');
    }
    const remove = event.target.closest('[data-remove-vacation]');
    if (!remove) return undefined;
    const res = await api('DELETE', `/api/admin/users/${member.id}/vacations/${remove.dataset.removeVacation}`);
    if (!res.ok) showToast(res.error, { tone: 'error' });
    await refreshVacations(member, els);
    return void load();
  });
}

async function manageVacations(member) {
  const contract = contractRow();
  const els = {
    summary: h('section', { class: 'vac-summary', 'aria-live': 'polite' }),
    list: h('ul', { class: 'vac-list', 'aria-live': 'polite' }, h('li', { class: 'vac-empty', text: 'Cargando…' })),
    contract: contract.input,
  };
  const root = h('div', { class: 'vac-panel' }, [els.summary, contract.node, h('p', { class: 'vac-heading', text: 'Periodos' }), els.list]);
  bindVacationEvents(member, els, root);
  const today = new Date().toISOString().slice(0, 10);
  const changed = openDialog({
    eyebrow: 'Vacaciones',
    title: `Vacaciones de ${member.name}`,
    lead: '30 días naturales al año, con el primero y el último de cada periodo incluidos. Los que no se usen antes del 31 de diciembre se pierden.',
    content: [
      root,
      h('div', { class: 'vac-form' }, [
        field({ label: 'Desde', name: 'start', type: 'date', value: today, required: true }),
        field({ label: 'Hasta', name: 'end', type: 'date', value: today, required: true }),
      ]),
      field({ label: 'Nota (opcional)', name: 'note', autocomplete: 'off', hint: 'Por ejemplo: verano, asuntos propios…' }),
    ],
    submitLabel: 'Añadir periodo',
    cancelLabel: 'Cerrar',
    onSubmit: async (form) => {
      const value = (name) => form.elements.namedItem(name).value;
      const res = await api('POST', `/api/admin/users/${member.id}/vacations`, {
        start: value('start'), end: value('end'), note: value('note'),
      });
      if (!res.ok) return { error: res.error };
      form.elements.namedItem('note').value = '';
      await refreshVacations(member, els);
      showToast(`Vacaciones añadidas: ${plural(res.data.days, 'día', 'días')}.`);
      return { stay: true };
    },
  });
  await refreshVacations(member, els);
  if (await changed) await load();
}

const ACTIONS = Object.freeze({
  vacations: manageVacations,
  edit: editMember,
  deactivate: deactivateMember,
  temp: temporaryPassword,
  access: (m) => simpleAction(m, 'send-access'),
  reactivate: (m) => simpleAction(m, 'reactivate', `${m.name} vuelve a tener acceso.`),
});

function bindEvents(root) {
  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-invite]')) return void inviteMember();
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      state.filter = filter.dataset.filter;
      return void renderList();
    }
    const button = event.target.closest('[data-action]');
    if (!button) return undefined;
    const member = memberById(button.closest('[data-id]').dataset.id);
    return void ACTIONS[button.dataset.action]?.(member);
  });
  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-role]')) changeRole(event.target);
  });
  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-search]')) return;
    state.query = event.target.value.trim().toLowerCase();
    renderList();
  });
}

/* ---------- Pantalla ---------- */

/** Pinta Admin › Usuarios. `params` admite ?accion=alta y ?estado=<filtro>. */
export function renderUsers({ main, user, params, backHref }) {
  state.me = user;
  state.query = '';
  state.filter = FILTERS.some((f) => f.id === params.get('estado')) ? params.get('estado') : 'todos';

  const list = h('ul', { class: 'member-list', 'aria-label': 'Equipo', 'aria-live': 'polite' },
    h('li', { class: 'member-empty' }, h('p', { text: 'Cargando el equipo…' })));
  const root = h('div', { class: 'users' }, [
    header(backHref),
    filterBar(),
    stagger(h('section', { class: 'bezel users-panel' }, h('div', { class: 'bezel-core users-core' }, list)), 4),
  ]);
  state.els = { root, list };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Usuarios · Puntapié';

  load().then(() => {
    if (params.get('accion') === 'alta') inviteMember();
  });
  return root.querySelector('h1');
}
