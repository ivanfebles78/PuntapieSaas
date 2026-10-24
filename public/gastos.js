import { api } from './api.js';
import { field, openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { centsToInput, currentMonth, formatBytes, formatEuros, isMonth, monthLabel, shiftMonth } from './format.js';
import { chooseExport, exportButton } from './export.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

const BASE_PATH = '/app/gastos';
const ACCEPT = '.pdf,image/jpeg,image/png,image/webp,image/heic';
const MAX_RANGE_MONTHS = 24;

// Tipo de gasto: nombre, icono y clase de color (cat-*), en el orden de la tabla.
export const CATEGORIES = Object.freeze([
  { id: 'recurrente', label: 'Recurrente', plural: 'Recurrentes', icon: 'repeat', description: 'Se paga cada mes: fijo (alquiler, nóminas…) o variable (luz, agua…).' },
  { id: 'proveedor', label: 'Proveedor', plural: 'Proveedores', icon: 'truck', description: 'Pago de una factura de proveedor, en su fecha.' },
  { id: 'esporadico', label: 'Esporádico', plural: 'Esporádicos', icon: 'flash', description: 'Un gasto puntual: reparaciones, compras sueltas, imprevistos.' },
]);
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const KIND_LABEL = Object.freeze({ fijo: 'Fijo', variable: 'Variable' });

const state = {
  mode: 'mes',
  from: currentMonth(),
  to: currentMonth(),
  data: null,
  filters: { cats: new Set(), status: 'todos', q: '', min: '', max: '' },
  els: null,
};

/* ---------- Utilidades ---------- */

const periodLabel = () => (state.mode === 'mes' || state.from === state.to
  ? monthLabel(state.from)
  : `${monthLabel(state.from)} – ${monthLabel(state.to)}`);

function formatDay(iso) {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

function parseEuros(text) {
  const clean = String(text ?? '').trim().replace(/\s|€/g, '');
  if (!clean) return null;
  const normal = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const value = Number(normal);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function filtersActive() {
  const f = state.filters;
  return f.cats.size > 0 || f.status !== 'todos' || f.q || f.min || f.max;
}

function visibleItems() {
  const f = state.filters;
  const min = parseEuros(f.min);
  const max = parseEuros(f.max);
  const q = f.q.toLowerCase();
  return state.data.items.filter((item) => (f.cats.size === 0 || f.cats.has(item.category))
    && (f.status === 'todos' || item.status === f.status)
    && (!q || item.name.toLowerCase().includes(q))
    && (min === null || item.amountCents >= min)
    && (max === null || item.amountCents <= max));
}

function summarize(items) {
  const sum = (list) => list.reduce((t, i) => t + i.amountCents, 0);
  return {
    total: sum(items),
    paid: sum(items.filter((i) => i.status === 'pagado')),
    pending: sum(items.filter((i) => i.status === 'pendiente')),
    pendingCount: items.filter((i) => i.status === 'pendiente').length,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c.id, sum(items.filter((i) => i.category === c.id))])),
  };
}

/* ---------- Cabecera, periodo y filtros ---------- */

function header(backHref) {
  return h('header', { class: 'module-head tone-gastos users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Inicio' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Gastos · Una sola tabla' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Gastos' }), 1),
    ])),
  ]);
}

function periodBar() {
  return stagger(h('div', { class: 'month-bar' }, [
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Periodo' }, [
      h('button', { type: 'button', 'data-mode': 'mes', text: 'Mes' }),
      h('button', { type: 'button', 'data-mode': 'rango', text: 'Varios meses' }),
    ]),
    h('div', { class: 'month-nav', role: 'group', 'aria-label': 'Cambiar de mes', 'data-when': 'mes' }, [
      h('button', { class: 'month-step', type: 'button', 'data-shift': '-1', 'aria-label': 'Mes anterior' }, icon('arrowLeft', 'ico ico-sm')),
      h('p', { class: 'month-label', 'data-month-label': '', 'aria-live': 'polite' }),
      h('button', { class: 'month-step', type: 'button', 'data-shift': '1', 'aria-label': 'Mes siguiente' }, icon('arrowRight', 'ico ico-sm')),
    ]),
    h('div', { class: 'range', 'data-when': 'rango' }, [
      h('label', {}, [h('span', { text: 'Desde' }), h('input', { type: 'month', 'data-range': 'from' })]),
      h('label', {}, [h('span', { text: 'Hasta' }), h('input', { type: 'month', 'data-range': 'to' })]),
    ]),
    h('button', { class: 'month-today', type: 'button', 'data-today': '', text: 'Mes actual' }),
    exportButton(),
    h('button', { class: 'cta month-cta', type: 'button', 'data-new': '' }, [
      h('span', { text: 'Nuevo gasto' }),
      h('span', { class: 'bubble bubble-cta' }, icon('wallet', 'ico ico-sm')),
    ]),
  ]), 2);
}

function filterBar() {
  return stagger(h('div', { class: 'filters', role: 'search' }, [
    h('div', { class: 'cat-filters', role: 'group', 'aria-label': 'Filtrar por tipo de gasto' },
      CATEGORIES.map((c) => h('button', { class: `cat-toggle cat-${c.id}`, type: 'button', 'data-cat': c.id, 'aria-pressed': 'false' }, [
        icon(c.icon, 'ico ico-xs'),
        h('span', { text: c.plural }),
        h('span', { class: 'cat-count', 'data-cat-count': c.id, text: '0' }),
      ]))),
    h('div', { class: 'segmented segmented-sm', role: 'group', 'aria-label': 'Filtrar por estado' }, [
      h('button', { type: 'button', 'data-status-filter': 'todos', text: 'Todos' }),
      h('button', { type: 'button', 'data-status-filter': 'pendiente', text: 'Pendientes' }),
      h('button', { type: 'button', 'data-status-filter': 'pagado', text: 'Pagados' }),
    ]),
    h('label', { class: 'search search-sm' }, [
      icon('search', 'ico ico-sm'),
      h('span', { class: 'sr-only', text: 'Buscar' }),
      h('input', { type: 'search', placeholder: 'Buscar concepto', 'data-filter': 'q', autocomplete: 'off' }),
    ]),
    h('div', { class: 'amount-range', role: 'group', 'aria-label': 'Filtrar por importe' }, [
      h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Mín. €', 'data-filter': 'min', 'aria-label': 'Importe mínimo' }),
      h('span', { 'aria-hidden': 'true', text: '–' }),
      h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Máx. €', 'data-filter': 'max', 'aria-label': 'Importe máximo' }),
    ]),
    h('button', { class: 'btn-text', type: 'button', 'data-clear': '', text: 'Quitar filtros' }),
  ]), 3);
}

function syncControls() {
  const root = state.els.root;
  root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  root.querySelectorAll('[data-when]').forEach((el) => { el.hidden = el.dataset.when !== state.mode; });
  root.querySelector('[data-month-label]').textContent = monthLabel(state.from);
  root.querySelector('[data-range="from"]').value = state.from;
  root.querySelector('[data-range="to"]').value = state.to;
  root.querySelector('[data-today]').hidden = state.mode === 'mes' && state.from === currentMonth();
  root.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(state.filters.cats.has(b.dataset.cat))));
  root.querySelectorAll('[data-status-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.statusFilter === state.filters.status)));
  root.querySelector('[data-clear]').hidden = !filtersActive();
}

/* ---------- Totales ---------- */

function renderTotals(items) {
  const t = summarize(items);
  const card = (label, value, detail, extra) => h('div', { class: `total ${extra}` }, [
    h('span', { class: 'total-label', text: label }),
    h('span', { class: 'total-value', text: value }),
    h('span', { class: 'total-detail', text: detail }),
  ]);
  state.els.root.querySelector('[data-totals]').replaceChildren(
    h('div', { class: 'total total-main' }, [
      h('span', { class: 'total-head' }, [
        h('span', { class: 'total-label', text: `Total gastos · ${periodLabel()}${filtersActive() ? ' · filtrado' : ''}` }),
        h('span', { class: 'total-value', text: formatEuros(t.total) }),
      ]),
      h('ul', { class: 'total-breakdown' }, CATEGORIES.map((c) => h('li', { class: `cat-${c.id}` }, [
        h('span', { class: 'cat-dot', 'aria-hidden': 'true' }),
        h('span', { text: c.plural }),
        h('strong', { text: formatEuros(t.byCategory[c.id]) }),
      ]))),
    ]),
    card('Pagado', formatEuros(t.paid), `${items.length - t.pendingCount} de ${items.length} gastos`, 'total-paid'),
    card('Pendiente', formatEuros(t.pending), t.pendingCount === 1 ? '1 gasto por pagar' : `${t.pendingCount} gastos por pagar`, 'total-pending'),
  );
  for (const c of CATEGORIES) {
    state.els.root.querySelector(`[data-cat-count="${c.id}"]`).textContent = String(state.data.items.filter((i) => i.category === c.id).length);
  }
}

/* ---------- Tabla ---------- */

function actionButton(action, label, iconName, extra = '') {
  return h('button', { class: `act ${extra}`, type: 'button', 'data-action': action, 'aria-label': label, title: label }, [
    icon(iconName, 'ico ico-sm'),
    h('span', { class: 'act-label', text: label }),
  ]);
}

function fileChip(file) {
  return h('li', { class: 'file' }, [
    h('a', { class: 'file-link', href: `/api/gastos/archivos/${file.id}`, target: '_blank', rel: 'noopener', title: `${file.filename} · ${formatBytes(file.size)}` },
      [icon(file.mime === 'application/pdf' ? 'receipt' : 'docDown', 'ico ico-xs'), h('span', { text: file.filename })]),
    h('button', { class: 'file-remove', type: 'button', 'data-remove-file': String(file.id), 'data-filename': file.filename, 'aria-label': `Borrar ${file.filename}` }, icon('close', 'ico ico-xs')),
  ]);
}

function filesCell(kind, files) {
  return h('td', { class: 'cell-files', 'data-label': kind === 'factura' ? 'Facturas' : 'Justificantes' }, h('div', { class: 'files' }, [
    files.length ? h('ul', { class: 'file-list' }, files.map(fileChip)) : null,
    h('button', { class: 'upload', type: 'button', 'data-upload': kind }, [
      icon('docDown', 'ico ico-xs'),
      h('span', { text: files.length ? 'Añadir' : `Subir ${kind}` }),
    ]),
  ]));
}

function amountCell(item) {
  const empty = item.amountSource === 'vacio';
  const note = item.kind === 'fijo' && item.amountSource === 'mes' ? `Solo este mes · fijo ${formatEuros(item.fixedAmountCents)}` : null;
  return h('td', { class: 'cell-amount', 'data-label': 'Importe' }, [
    h('button', { class: `amount${empty ? ' amount-empty' : ''}`, type: 'button', 'data-amount': '' }, empty ? 'Añadir importe' : formatEuros(item.amountCents)),
    note ? h('span', { class: 'amount-note', text: note }) : null,
  ]);
}

function whenCell(item) {
  const text = item.date ? formatDay(item.date) : state.mode === 'rango' ? monthLabel(item.month) : 'Cada mes';
  const detail = item.date && state.mode === 'rango' ? monthLabel(item.month) : null;
  return h('td', { class: 'cell-when', 'data-label': 'Fecha' }, [h('span', { text }), detail ? h('small', { text: detail }) : null]);
}

function row(item, index) {
  const cat = CATEGORY[item.category];
  const paid = item.status === 'pagado';
  const tr = h('tr', { class: `expense cat-row-${item.category}`, 'data-id': String(item.id), 'data-month': item.month }, [
    whenCell(item),
    h('th', { scope: 'row', class: 'cell-name' }, [
      h('span', { class: 'expense-name', text: item.name }),
      h('span', { class: 'tags' }, [
        h('span', { class: `cat-badge cat-${item.category}` }, [icon(cat.icon, 'ico ico-xs'), h('span', { text: cat.label })]),
        KIND_LABEL[item.kind] ? h('span', { class: 'kind', text: KIND_LABEL[item.kind] }) : null,
      ]),
    ]),
    amountCell(item),
    filesCell('factura', item.invoices),
    filesCell('justificante', item.receipts),
    h('td', { class: 'cell-status', 'data-label': 'Estado' }, h('button', {
      class: `state ${paid ? 'state-paid' : 'state-pending'}`, type: 'button', 'data-toggle-status': '', 'aria-pressed': String(paid),
      title: paid ? 'Marcar como pendiente' : 'Marcar como pagado',
    }, [h('span', { class: 'state-dot', 'aria-hidden': 'true' }), h('span', { text: paid ? 'Pagado' : 'Pendiente' })])),
    h('td', { class: 'cell-actions' }, h('span', { class: 'member-actions' }, [
      actionButton('rename', 'Cambiar concepto', 'magic'),
      actionButton('end', item.kind === 'unico' ? 'Borrar' : 'Dejar de pagar', 'close', 'act-danger'),
    ])),
  ]);
  tr.style.setProperty('--i', String(index));
  return tr;
}

function renderTable(items) {
  const t = summarize(items);
  const empty = state.data.items.length === 0
    ? `No hay gastos en ${periodLabel()}. Pulsa «Nuevo gasto» para añadir el primero.`
    : 'Ningún gasto coincide con los filtros.';
  state.els.table.replaceChildren(
    h('thead', {}, h('tr', {}, ['Fecha', 'Concepto', 'Importe', 'Facturas', 'Justificantes', 'Estado', ''].map((x) => h('th', { scope: 'col', text: x })))),
    h('tbody', {}, items.length ? items.map(row) : h('tr', {}, h('td', { class: 'member-empty', colspan: '7' }, [icon('wallet', 'ico ico-xl'), h('p', { text: empty })]))),
    items.length ? h('tfoot', {}, h('tr', {}, [
      h('th', { scope: 'row', colspan: '2', text: `Total ${periodLabel()}${filtersActive() ? ' (filtrado)' : ''}` }),
      h('td', { class: 'cell-amount', colspan: '5' }, h('strong', { text: formatEuros(t.total) })),
    ])) : null,
  );
}

function render() {
  syncControls();
  const items = visibleItems();
  renderTotals(items);
  renderTable(items);
}

/* ---------- Datos ---------- */

async function load() {
  const query = state.mode === 'mes' ? `mes=${state.from}` : `desde=${state.from}&hasta=${state.to}`;
  const res = await api('GET', `/api/gastos?${query}`);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  state.data = res.data;
  history.replaceState(history.state, '', `${BASE_PATH}?${query}`);
  return void render();
}

function setPeriod(mode, from, to = from) {
  if (to < from) [from, to] = [to, from];
  if (shiftMonth(from, MAX_RANGE_MONTHS - 1) < to) {
    showToast(`Como máximo ${MAX_RANGE_MONTHS} meses a la vez.`, { tone: 'error' });
    to = shiftMonth(from, MAX_RANGE_MONTHS - 1);
  }
  Object.assign(state, { mode, from, to: mode === 'mes' ? from : to });
  load();
}

function itemFor(el) {
  const rowEl = el.closest('[data-id]');
  return state.data.items.find((i) => i.id === Number(rowEl.dataset.id) && i.month === rowEl.dataset.month);
}

/* ---------- Diálogos ---------- */

function choiceCards(name, legend, items, selected) {
  return h('fieldset', { class: 'role-cards role-cards-3' }, [
    h('legend', { text: legend }),
    ...items.map((o) => h('label', { class: `role-card ${o.className ?? ''}` }, [
      h('input', { type: 'radio', name, value: o.value, checked: o.value === selected }),
      h('span', { class: 'role-card-icon' }, icon(o.icon, 'ico ico-md')),
      h('span', { class: 'role-card-name', text: o.label }),
      h('span', { class: 'role-card-desc', text: o.description }),
    ])),
  ]);
}

const valueOf = (form, name) => form.elements.namedItem(name).value;

function newExpenseFields() {
  const today = new Date();
  const todayIso = `${state.from}-${String(state.from === currentMonth() ? today.getDate() : 1).padStart(2, '0')}`;
  const recurring = h('div', { class: 'when-recurring' }, [
    choiceCards('kind', 'Cómo se repite', [
      { value: 'fijo', label: 'Fijo', icon: 'repeat', description: 'Mismo importe cada mes. Se repite solo.' },
      { value: 'variable', label: 'Variable', icon: 'flash', description: 'Cambia cada mes. Empieza en 0.' },
    ], 'fijo'),
    field({ label: 'Desde el mes', name: 'startMonth', type: 'month', value: state.from }),
  ]);
  const once = h('div', { class: 'when-once', hidden: true }, field({ label: 'Fecha', name: 'date', type: 'date', value: todayIso }));
  const categories = choiceCards('category', 'Tipo de gasto', CATEGORIES.map((c) => ({
    value: c.id, label: c.label, icon: c.icon, description: c.description, className: `cat-card cat-${c.id}`,
  })), 'recurrente');
  categories.addEventListener('change', () => {
    const isRecurring = categories.querySelector('input:checked').value === 'recurrente';
    recurring.hidden = !isRecurring;
    once.hidden = isRecurring;
  });
  return [
    field({ label: 'Concepto', name: 'name', autocomplete: 'off', hint: 'Por ejemplo: Alquiler, Luz, Factura Garvalín 1234, Reparación persiana…' }),
    categories,
    recurring,
    once,
    field({ label: 'Importe (€)', name: 'amount', inputmode: 'decimal', autocomplete: 'off', hint: 'En los variables es opcional: el importe de ese mes.' }),
  ];
}

async function newExpense() {
  const created = await openDialog({
    eyebrow: 'Nuevo gasto',
    title: 'Añadir un gasto',
    content: newExpenseFields(),
    submitLabel: 'Añadir gasto',
    onSubmit: async (form) => {
      const category = valueOf(form, 'category');
      const amount = valueOf(form, 'amount').trim();
      const body = { name: valueOf(form, 'name'), category, amount };
      if (category === 'recurrente') {
        Object.assign(body, { kind: valueOf(form, 'kind'), startMonth: valueOf(form, 'startMonth') });
        if (body.kind === 'fijo' && !amount) return { error: 'Escribe el importe del gasto fijo.' };
      } else {
        body.date = valueOf(form, 'date');
        if (!amount) return { error: 'Escribe el importe del gasto.' };
      }
      const res = await api('POST', '/api/gastos', body);
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
    eyebrow: `${CATEGORY[item.category].label} · ${monthLabel(item.month)}`,
    title: item.name,
    lead: isFixed ? `Importe fijo actual: ${formatEuros(item.fixedAmountCents)}.` : 'Importe según la factura.',
    content: [
      field({ label: 'Importe (€)', name: 'amount', inputmode: 'decimal', autocomplete: 'off', value: item.amountSource === 'vacio' ? '' : centsToInput(item.amountCents) }),
      isFixed ? choiceCards('scope', '¿A qué meses afecta?', [
        { value: 'mes', label: 'Solo este mes', icon: 'calendar', description: `Un cambio puntual en ${monthLabel(item.month)}.` },
        { value: 'desde', label: 'Desde este mes', icon: 'repeat', description: `Nuevo importe fijo a partir de ${monthLabel(item.month)}.` },
      ], 'desde') : null,
    ],
    submitLabel: 'Guardar importe',
    onSubmit: async (form) => {
      const res = await api('PUT', `/api/gastos/${item.id}/importe`, {
        month: item.month, amount: valueOf(form, 'amount'), scope: isFixed ? valueOf(form, 'scope') : 'mes',
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
      const res = await api('PATCH', `/api/gastos/${item.id}`, { name: valueOf(form, 'name') });
      return res.ok ? true : { error: res.error };
    },
  });
  if (saved) await load();
}

async function endExpense(item) {
  const deletes = item.kind === 'unico' || item.startMonth === item.month;
  const done = await openDialog({
    eyebrow: deletes ? 'Borrar' : 'Dejar de pagar',
    title: deletes ? `¿Borrar «${item.name}»?` : `¿Dejar de pagar «${item.name}»?`,
    lead: deletes
      ? 'Se borrará del todo, con sus facturas y justificantes.'
      : `Dejará de aparecer desde ${monthLabel(item.month)}. Los meses anteriores no cambian; lo apuntado desde ${monthLabel(item.month)} se borra.`,
    submitLabel: deletes ? 'Borrar gasto' : 'Dejar de pagar',
    tone: 'danger',
    onSubmit: async () => {
      const res = await api('POST', `/api/gastos/${item.id}/fin`, { month: item.month });
      return res.ok ? res.data : { error: res.error };
    },
  });
  if (!done) return;
  showToast(done.deleted ? 'Gasto borrado.' : `«${item.name}» ya no cuenta desde ${monthLabel(item.month)}.`);
  await load();
}

/* ---------- Estado y documentos ---------- */

async function toggleStatus(item) {
  const status = item.status === 'pagado' ? 'pendiente' : 'pagado';
  const res = await api('PUT', `/api/gastos/${item.id}/estado`, { month: item.month, status });
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  return void load();
}

async function uploadFiles(item, kind, files) {
  let uploaded = 0;
  for (const file of files) {
    let res;
    try {
      res = await fetch(`/api/gastos/${item.id}/archivos?mes=${item.month}&tipo=${kind}`, {
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
      ? `Justificante subido: «${item.name}» queda como pagado.`
      : uploaded === 1 ? 'Factura subida.' : `${uploaded} facturas subidas.`);
  }
  await load();
}

function pickFiles(button) {
  const item = itemFor(button);
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
  input.addEventListener('change', async () => {
    if (!input.files.length) return;
    button.setAttribute('aria-busy', 'true');
    await uploadFiles(item, button.dataset.upload, [...input.files]);
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

/* ---------- Eventos ---------- */

const ROW_ACTIONS = Object.freeze({ rename: renameExpense, end: endExpense });

/** Clic en el periodo (modo, flechas, mes actual). Devuelve true si lo atendió. */
function onPeriodClick(target) {
  const mode = target.closest('[data-mode]');
  if (mode) {
    const isRange = mode.dataset.mode === 'rango';
    setPeriod(mode.dataset.mode, state.from, isRange ? shiftMonth(state.from, 2) : state.from);
    return true;
  }
  const shift = target.closest('[data-shift]');
  if (shift) {
    setPeriod('mes', shiftMonth(state.from, Number(shift.dataset.shift)));
    return true;
  }
  if (target.closest('[data-today]')) {
    setPeriod('mes', currentMonth());
    return true;
  }
  if (target.closest('[data-export]')) {
    chooseExport({
      title: 'Exportar gastos',
      lead: 'Un ZIP con el Excel de todos los movimientos y todas las facturas y justificantes, ordenados por mes y concepto.',
      options: [
        { id: 'periodo', label: periodLabel(), detail: 'Lo que estás viendo ahora', url: `/api/gastos/exportar?desde=${state.from}&hasta=${state.to}` },
        { id: 'todo', label: 'Todo el historial', detail: 'Desde el primer gasto registrado hasta este mes', url: '/api/gastos/exportar?todo=1' },
      ],
    });
    return true;
  }
  return false;
}

function clearFilters() {
  state.filters = { cats: new Set(), status: 'todos', q: '', min: '', max: '' };
  state.els.root.querySelectorAll('[data-filter]').forEach((input) => { input.value = ''; });
}

/** Clic en los filtros de tipo o estado. Devuelve true si lo atendió. */
function onFilterClick(target) {
  const cat = target.closest('[data-cat]');
  const status = target.closest('[data-status-filter]');
  if (cat) {
    const { cats } = state.filters;
    if (cats.has(cat.dataset.cat)) cats.delete(cat.dataset.cat);
    else cats.add(cat.dataset.cat);
  } else if (status) {
    state.filters.status = status.dataset.statusFilter;
  } else if (target.closest('[data-clear]')) {
    clearFilters();
  } else {
    return false;
  }
  render();
  return true;
}

function onRowClick(target) {
  if (!target.closest('[data-id]')) return;
  const item = itemFor(target);
  if (target.closest('[data-amount]')) return void editAmount(item);
  if (target.closest('[data-toggle-status]')) return void toggleStatus(item);
  const upload = target.closest('[data-upload]');
  if (upload) return void pickFiles(upload);
  const remove = target.closest('[data-remove-file]');
  if (remove) return void removeFile(remove);
  const action = target.closest('[data-action]');
  if (action) ROW_ACTIONS[action.dataset.action]?.(item);
}

function bindEvents(root) {
  root.addEventListener('click', (event) => {
    const { target } = event;
    if (target.closest('[data-new]')) return void newExpense();
    if (onPeriodClick(target) || onFilterClick(target)) return undefined;
    return void onRowClick(target);
  });
  root.addEventListener('input', (event) => {
    const key = event.target.dataset.filter;
    if (!key) return;
    state.filters[key] = event.target.value.trim();
    render();
  });
  root.addEventListener('change', (event) => {
    const which = event.target.dataset.range;
    if (!which || !isMonth(event.target.value)) return;
    const from = which === 'from' ? event.target.value : state.from;
    const to = which === 'to' ? event.target.value : state.to;
    setPeriod('rango', from, to);
  });
}

/* ---------- Pantalla ---------- */

/** Pinta Gastos (una sola tabla). Admite ?mes=AAAA-MM o ?desde=AAAA-MM&hasta=AAAA-MM. */
export function renderExpenses({ main, params, backHref }) {
  const from = params.get('desde');
  const to = params.get('hasta');
  if (isMonth(from) && isMonth(to)) Object.assign(state, { mode: 'rango', from, to });
  else Object.assign(state, { mode: 'mes', from: isMonth(params.get('mes')) ? params.get('mes') : currentMonth() });
  if (state.mode === 'mes') state.to = state.from;
  state.filters = { cats: new Set(), status: 'todos', q: '', min: '', max: '' };

  const table = h('table', { class: 'expenses', 'aria-label': 'Gastos' });
  const root = h('div', { class: 'recurring expenses-view' }, [
    header(backHref),
    periodBar(),
    stagger(h('section', { class: 'totals', 'aria-label': 'Totales', 'data-totals': '' }), 3),
    filterBar(),
    stagger(h('section', { class: 'bezel users-panel' }, h('div', { class: 'bezel-core users-core table-scroll' }, table)), 4),
  ]);
  state.els = { root, table };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Gastos · Puntapié';
  table.append(h('tbody', {}, h('tr', {}, h('td', { class: 'member-empty', text: 'Cargando…' }))));
  load();
  return root.querySelector('h1');
}
