import { api } from './api.js';
import { field, openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { centsToInput, currentMonth, formatBytes, formatEuros, isMonth, monthLabel, shiftMonth } from './format.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

const BASE_PATH = '/app/gastos/recurrentes';
const ACCEPT = '.pdf,image/jpeg,image/png,image/webp,image/heic';
const KIND_LABEL = Object.freeze({ fijo: 'Fijo', variable: 'Variable' });
const DOC_LABEL = Object.freeze({ factura: 'factura', justificante: 'justificante' });

const state = { month: currentMonth(), data: null, els: null };

/* ---------- Cabecera, mes y totales ---------- */

function header(backHref) {
  return h('header', { class: 'module-head tone-gastos users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Gastos' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Gastos · Recurrentes' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Gastos recurrentes' }), 1),
    ])),
  ]);
}

function monthBar() {
  return stagger(h('div', { class: 'month-bar' }, [
    h('div', { class: 'month-nav', role: 'group', 'aria-label': 'Cambiar de mes' }, [
      h('button', { class: 'month-step', type: 'button', 'data-shift': '-1', 'aria-label': 'Mes anterior' }, icon('arrowLeft', 'ico ico-sm')),
      h('p', { class: 'month-label', 'data-month-label': '', 'aria-live': 'polite' }),
      h('button', { class: 'month-step', type: 'button', 'data-shift': '1', 'aria-label': 'Mes siguiente' }, icon('arrowRight', 'ico ico-sm')),
    ]),
    h('button', { class: 'month-today', type: 'button', 'data-today': '', text: 'Volver al mes actual' }),
    h('button', { class: 'cta month-cta', type: 'button', 'data-new': '' }, [
      h('span', { text: 'Nuevo gasto' }),
      h('span', { class: 'bubble bubble-cta' }, icon('wallet', 'ico ico-sm')),
    ]),
  ]), 3);
}

function totalsStrip() {
  return stagger(h('section', { class: 'totals', 'aria-label': 'Totales del mes', 'data-totals': '' }), 3);
}

function renderTotals() {
  const { totals } = state.data;
  const card = (label, value, detail, extra = '') => h('div', { class: `total ${extra}` }, [
    h('span', { class: 'total-label', text: label }),
    h('span', { class: 'total-value', text: value }),
    detail ? h('span', { class: 'total-detail', text: detail }) : null,
  ]);
  state.els.root.querySelector('[data-totals]').replaceChildren(
    h('div', { class: 'total total-main' }, [
      h('span', { class: 'total-head' }, [
        h('span', { class: 'total-label', text: `Total gastos · ${monthLabel(state.month)}` }),
        h('span', { class: 'total-value', text: formatEuros(totals.totalCents) }),
      ]),
      h('ul', { class: 'total-breakdown' }, [
        h('li', {}, [h('span', { text: 'Recurrentes' }), h('strong', { text: formatEuros(totals.totalCents) })]),
        h('li', { class: 'is-soon' }, [h('span', { text: 'No recurrentes' }), h('strong', { text: 'pronto' })]),
        h('li', { class: 'is-soon' }, [h('span', { text: 'Pagos a proveedores' }), h('strong', { text: 'pronto' })]),
      ]),
    ]),
    card('Pagado', formatEuros(totals.paidCents), `${totals.count - totals.pendingCount} de ${totals.count} gastos`, 'total-paid'),
    card('Pendiente', formatEuros(totals.pendingCents), totals.pendingCount === 1 ? '1 gasto por pagar' : `${totals.pendingCount} gastos por pagar`, 'total-pending'),
  );
}

/* ---------- Tabla ---------- */

function fileChip(file) {
  return h('li', { class: 'file' }, [
    h('a', {
      class: 'file-link',
      href: `/api/gastos/archivos/${file.id}`,
      target: '_blank',
      rel: 'noopener',
      title: `${file.filename} · ${formatBytes(file.size)}`,
    }, [icon(file.mime === 'application/pdf' ? 'receipt' : 'docDown', 'ico ico-xs'), h('span', { text: file.filename })]),
    h('button', { class: 'file-remove', type: 'button', 'data-remove-file': String(file.id), 'data-filename': file.filename, 'aria-label': `Borrar ${file.filename}` }, icon('close', 'ico ico-xs')),
  ]);
}

function filesCell(item, kind, files) {
  return h('td', { class: 'cell-files', 'data-label': kind === 'factura' ? 'Facturas' : 'Justificantes' }, h('div', { class: 'files' }, [
    files.length ? h('ul', { class: 'file-list' }, files.map(fileChip)) : null,
    h('button', { class: 'upload', type: 'button', 'data-upload': kind, 'data-id': String(item.id) }, [
      icon('docDown', 'ico ico-xs'),
      h('span', { text: files.length ? 'Añadir' : `Subir ${DOC_LABEL[kind]}` }),
    ]),
  ]));
}

function amountCell(item) {
  const empty = item.amountSource === 'vacio';
  const note = item.kind === 'fijo' && item.amountSource === 'mes'
    ? `Solo este mes · fijo ${formatEuros(item.fixedAmountCents)}` : null;
  return h('td', { class: 'cell-amount', 'data-label': 'Importe' }, [
    h('button', { class: `amount${empty ? ' amount-empty' : ''}`, type: 'button', 'data-amount': String(item.id) },
      empty ? 'Añadir importe' : formatEuros(item.amountCents)),
    note ? h('span', { class: 'amount-note', text: note }) : null,
  ]);
}

function row(item, index) {
  const paid = item.status === 'pagado';
  const tr = h('tr', { class: `expense expense-${item.status}`, 'data-id': String(item.id) }, [
    h('th', { scope: 'row', class: 'cell-name' }, [
      h('span', { class: 'expense-name', text: item.name }),
      h('span', { class: `kind kind-${item.kind}`, text: KIND_LABEL[item.kind] }),
    ]),
    amountCell(item),
    filesCell(item, 'factura', item.invoices),
    filesCell(item, 'justificante', item.receipts),
    h('td', { class: 'cell-status', 'data-label': 'Estado' }, h('button', {
      class: `state ${paid ? 'state-paid' : 'state-pending'}`,
      type: 'button',
      'data-toggle-status': String(item.id),
      'aria-pressed': String(paid),
      title: paid ? 'Marcar como pendiente' : 'Marcar como pagado',
    }, [h('span', { class: 'state-dot', 'aria-hidden': 'true' }), h('span', { text: paid ? 'Pagado' : 'Pendiente' })])),
    h('td', { class: 'cell-actions' }, h('span', { class: 'member-actions' }, [
      actionButton('rename', 'Cambiar concepto', 'magic'),
      actionButton('end', 'Dejar de pagar', 'close', 'act-danger'),
    ])),
  ]);
  tr.style.setProperty('--i', String(index));
  return tr;
}

function actionButton(action, label, iconName, extra = '') {
  return h('button', { class: `act ${extra}`, type: 'button', 'data-action': action, 'aria-label': label, title: label }, [
    icon(iconName, 'ico ico-sm'),
    h('span', { class: 'act-label', text: label }),
  ]);
}

function renderTable() {
  const { items, totals } = state.data;
  const body = items.length
    ? items.map(row)
    : [h('tr', {}, h('td', { class: 'member-empty', colspan: '6' }, [
      icon('wallet', 'ico ico-xl'),
      h('p', { text: `No hay gastos recurrentes en ${monthLabel(state.month)}. Pulsa «Nuevo gasto» para añadir el primero.` }),
    ]))];
  state.els.table.replaceChildren(
    h('thead', {}, h('tr', {}, ['Concepto', 'Importe', 'Facturas', 'Justificantes', 'Estado', ''].map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, body),
    items.length ? h('tfoot', {}, h('tr', {}, [
      h('th', { scope: 'row', text: `Total ${monthLabel(state.month)}` }),
      h('td', { class: 'cell-amount', colspan: '5' }, h('strong', { text: formatEuros(totals.totalCents) })),
    ])) : null,
  );
}

/* ---------- Datos ---------- */

async function load() {
  const res = await api('GET', `/api/gastos/recurrentes?mes=${state.month}`);
  if (!res.ok) {
    showToast(res.error, { tone: 'error' });
    return;
  }
  state.data = res.data;
  state.els.root.querySelector('[data-month-label]').textContent = monthLabel(state.month);
  state.els.root.querySelector('[data-today]').hidden = state.month === currentMonth();
  renderTotals();
  renderTable();
}

function goToMonth(month) {
  state.month = month;
  history.replaceState(history.state, '', `${BASE_PATH}?mes=${month}`);
  load();
}

function itemById(id) {
  return state.data.items.find((item) => item.id === Number(id));
}

/* ---------- Diálogos ---------- */

function choiceCards(name, options, selected) {
  return h('fieldset', { class: 'role-cards' }, [
    h('legend', { text: options.legend }),
    ...options.items.map((o) => h('label', { class: `role-card${o.dark ? ' role-admin' : ''}` }, [
      h('input', { type: 'radio', name, value: o.value, checked: o.value === selected }),
      h('span', { class: 'role-card-icon' }, icon(o.icon, 'ico ico-md')),
      h('span', { class: 'role-card-name', text: o.label }),
      h('span', { class: 'role-card-desc', text: o.description }),
    ])),
  ]);
}

const valueOf = (form, name) => form.elements.namedItem(name).value;

async function newExpense() {
  const created = await openDialog({
    eyebrow: 'Nuevo gasto recurrente',
    title: 'Añadir un gasto de cada mes',
    content: [
      field({ label: 'Concepto', name: 'name', autocomplete: 'off', hint: 'Por ejemplo: Alquiler, Luz, Nómina Elena, Alarma…' }),
      choiceCards('kind', {
        legend: 'Tipo',
        items: [
          { value: 'fijo', label: 'Fijo', icon: 'repeat', description: 'Mismo importe cada mes (alquiler, nóminas, alarma…). Se repite solo.' },
          { value: 'variable', label: 'Variable', icon: 'flash', description: 'Cambia según el consumo (luz, agua…). Empieza cada mes en 0.' },
        ],
      }, 'fijo'),
      h('div', { class: 'vac-form' }, [
        field({ label: 'Importe (€)', name: 'amount', inputmode: 'decimal', autocomplete: 'off', hint: 'En los variables, el de este mes (opcional).' }),
        field({ label: 'Desde el mes', name: 'startMonth', type: 'month', value: state.month }),
      ]),
    ],
    submitLabel: 'Añadir gasto',
    onSubmit: async (form) => {
      const kind = valueOf(form, 'kind');
      const amount = valueOf(form, 'amount').trim();
      if (kind === 'fijo' && !amount) return { error: 'Escribe el importe del gasto fijo.' };
      const res = await api('POST', '/api/gastos/recurrentes', {
        name: valueOf(form, 'name'), kind, amount, startMonth: valueOf(form, 'startMonth'),
      });
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!created) return;
  showToast('Gasto añadido.');
  await load();
}

async function editAmount(item) {
  const isFixed = item.kind === 'fijo';
  const saved = await openDialog({
    eyebrow: `${KIND_LABEL[item.kind]} · ${monthLabel(state.month)}`,
    title: item.name,
    lead: isFixed
      ? `Importe fijo actual: ${formatEuros(item.fixedAmountCents)}.`
      : 'Importe de este mes según la factura.',
    content: [
      field({ label: 'Importe (€)', name: 'amount', inputmode: 'decimal', autocomplete: 'off', value: item.amountSource === 'vacio' ? '' : centsToInput(item.amountCents) }),
      isFixed ? choiceCards('scope', {
        legend: '¿A qué meses afecta?',
        items: [
          { value: 'mes', label: 'Solo este mes', icon: 'calendar', description: `Un cambio puntual en ${monthLabel(state.month)}. Los demás meses siguen igual.` },
          { value: 'desde', label: 'Desde este mes', icon: 'repeat', description: `Nuevo importe fijo a partir de ${monthLabel(state.month)} (subida del alquiler, de una nómina…).` },
        ],
      }, 'desde') : null,
    ],
    submitLabel: 'Guardar importe',
    onSubmit: async (form) => {
      const res = await api('PUT', `/api/gastos/recurrentes/${item.id}/importe`, {
        month: state.month,
        amount: valueOf(form, 'amount'),
        scope: isFixed ? valueOf(form, 'scope') : 'mes',
      });
      return res.ok ? true : { error: res.error };
    },
  });
  if (!saved) return;
  showToast('Importe guardado.');
  await load();
}

async function renameExpense(item) {
  const saved = await openDialog({
    eyebrow: 'Concepto',
    title: 'Cambiar el concepto',
    content: field({ label: 'Concepto', name: 'name', value: item.name, autocomplete: 'off' }),
    submitLabel: 'Guardar',
    onSubmit: async (form) => {
      const res = await api('PATCH', `/api/gastos/recurrentes/${item.id}`, { name: valueOf(form, 'name') });
      return res.ok ? true : { error: res.error };
    },
  });
  if (saved) await load();
}

async function endExpense(item) {
  const firstMonth = item.startMonth === state.month;
  const done = await openDialog({
    eyebrow: 'Dejar de pagar',
    title: firstMonth ? `¿Borrar «${item.name}»?` : `¿Dejar de pagar «${item.name}»?`,
    lead: firstMonth
      ? 'Empezó este mismo mes, así que se borrará del todo, con sus facturas y justificantes.'
      : `Dejará de aparecer desde ${monthLabel(state.month)}. Los meses anteriores no cambian; lo apuntado en ${monthLabel(state.month)} y después se borra.`,
    submitLabel: firstMonth ? 'Borrar gasto' : 'Dejar de pagar',
    tone: 'danger',
    onSubmit: async () => {
      const res = await api('POST', `/api/gastos/recurrentes/${item.id}/fin`, { month: state.month });
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!done) return;
  showToast(done.deleted ? 'Gasto borrado.' : `«${item.name}» ya no cuenta desde ${monthLabel(state.month)}.`);
  await load();
}

/* ---------- Estado y documentos ---------- */

async function toggleStatus(id) {
  const item = itemById(id);
  const status = item.status === 'pagado' ? 'pendiente' : 'pagado';
  const res = await api('PUT', `/api/gastos/recurrentes/${id}/estado`, { month: state.month, status });
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  return void load();
}

async function uploadFiles(id, kind, files) {
  let uploaded = 0;
  for (const file of files) {
    let res;
    try {
      res = await fetch(`/api/gastos/recurrentes/${id}/archivos?mes=${state.month}&tipo=${kind}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      showToast('No hay conexión con el servidor. Inténtalo de nuevo.', { tone: 'error' });
      break;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) showToast(`${file.name}: ${json.error ?? 'no se pudo subir.'}`, { tone: 'error' });
    else uploaded += 1;
  }
  if (uploaded) {
    showToast(kind === 'justificante'
      ? `Justificante subido: «${itemById(id).name}» queda como pagado.`
      : uploaded === 1 ? 'Factura subida.' : `${uploaded} facturas subidas.`);
  }
  await load();
}

function pickFiles(button) {
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
  input.addEventListener('change', async () => {
    if (!input.files.length) return;
    button.setAttribute('aria-busy', 'true');
    await uploadFiles(button.dataset.id, button.dataset.upload, [...input.files]);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

async function removeFile(button) {
  const done = await openDialog({
    eyebrow: 'Documento',
    title: '¿Borrar este documento?',
    lead: `Se borrará «${button.dataset.filename}». Si es el último justificante, el gasto vuelve a «pendiente».`,
    submitLabel: 'Borrar',
    tone: 'danger',
    onSubmit: async () => {
      const res = await api('DELETE', `/api/gastos/archivos/${button.dataset.removeFile}`);
      return res.ok ? true : { error: res.error };
    },
  });
  if (done) await load();
}

const ROW_ACTIONS = Object.freeze({ rename: renameExpense, end: endExpense });

function bindEvents(root) {
  root.addEventListener('click', (event) => {
    const target = event.target;
    const shift = target.closest('[data-shift]');
    if (shift) return void goToMonth(shiftMonth(state.month, Number(shift.dataset.shift)));
    if (target.closest('[data-today]')) return void goToMonth(currentMonth());
    if (target.closest('[data-new]')) return void newExpense();
    const amount = target.closest('[data-amount]');
    if (amount) return void editAmount(itemById(amount.dataset.amount));
    const status = target.closest('[data-toggle-status]');
    if (status) return void toggleStatus(status.dataset.toggleStatus);
    const upload = target.closest('[data-upload]');
    if (upload) return void pickFiles(upload);
    const remove = target.closest('[data-remove-file]');
    if (remove) return void removeFile(remove);
    const action = target.closest('[data-action]');
    if (action) return void ROW_ACTIONS[action.dataset.action]?.(itemById(action.closest('[data-id]').dataset.id));
    return undefined;
  });
}

/* ---------- Pantalla ---------- */

/** Pinta Gastos › Recurrentes. Admite ?mes=AAAA-MM. */
export function renderRecurring({ main, params, backHref }) {
  state.month = isMonth(params.get('mes')) ? params.get('mes') : currentMonth();
  const table = h('table', { class: 'expenses', 'aria-label': 'Gastos recurrentes del mes' });
  const root = h('div', { class: 'recurring' }, [
    header(backHref),
    monthBar(),
    totalsStrip(),
    stagger(h('section', { class: 'bezel users-panel' }, h('div', { class: 'bezel-core users-core table-scroll' }, table)), 4),
  ]);
  state.els = { root, table };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Gastos recurrentes · Puntapié';
  table.append(h('tbody', {}, h('tr', {}, h('td', { class: 'member-empty', text: 'Cargando…' }))));
  load();
  return root.querySelector('h1');
}
