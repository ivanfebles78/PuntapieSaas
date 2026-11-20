import { api } from './api.js';
import { barChart, divergingBarChart, donutChart, lineChart } from './charts.js';
import { openDialog } from './dialogs.js';
import { h, stagger } from './dom.js';
import { centsToInput, formatEuros, monthLabel } from './format.js';
import { download, exportButton } from './export.js';
import { icon } from './icons.js';
import { renderStaffView } from './stats-staff.js';
import { showToast } from './toast.js';

const BASE_PATH = '/app/estadisticas';
const PERIODS = Object.freeze([['3m', '3 meses'], ['6m', '6 meses'], ['12m', '12 meses'], ['anio', 'Este año']]);
// Pestañas: la tienda en general y, para el Administrador, el equipo.
const VIEWS = Object.freeze([['tienda', 'Tienda', 'shop'], ['empleados', 'Empleados', 'people']]);
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
// Orden fijo de colores (categórico, validado): efectivo, tarjeta, bizum, bonos, vales.
const METHODS = Object.freeze([
  { id: 'efectivo', label: 'Efectivo', slot: 1 },
  { id: 'tarjeta', label: 'Tarjeta', slot: 2 },
  { id: 'bizum', label: 'Bizum', slot: 3 },
  { id: 'bonos', label: 'Bonos consumo', slot: 4 },
  { id: 'vales', label: 'Vales', slot: 5 },
]);

const count = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });
const euros0 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' });
const pct = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 0 });
const eurosShort = (cents) => euros0.format(cents / 100);
// Eje: hasta 9.999 € en euros exactos; desde 10.000 €, en miles («25 k»).
const axisEuros = (cents) => (cents >= 1000000 ? `${count.format(Math.round(cents / 10000) / 10).replace(',0', '')} k` : count.format(Math.round(cents / 100)));
const dayLabel = (day) => `${Number(day.slice(8))} ${SHORT_MONTHS[Number(day.slice(5, 7)) - 1]}`;
const monthShort = (month) => `${SHORT_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;

const DEFAULT_PERIOD = 'anio';
const state = { view: 'tienda', period: DEFAULT_PERIOD, simulate: false, data: null, user: null, els: null, resize: null, drawStaff: null };

/* ---------- Cabecera y controles ---------- */

function header(backHref) {
  return h('header', { class: 'module-head tone-estadisticas users-head' }, [
    stagger(h('a', { class: 'back', href: backHref, 'data-nav': '' }, [
      h('span', { class: 'bubble bubble-ghost' }, icon('arrowLeft', 'ico ico-sm')),
      h('span', { text: 'Inicio' }),
    ]), 0),
    h('div', { class: 'users-title-row' }, h('div', {}, [
      stagger(h('p', { class: 'eyebrow-pill', text: 'Estadísticas · Ventas y objetivos' }), 1),
      stagger(h('h1', { class: 'module-title', tabindex: '-1', text: 'Estadísticas' }), 1),
    ])),
  ]);
}

function controls() {
  const isAdmin = state.user.role === 'admin';
  const seesTeam = isAdmin || state.user.role === 'asesor';
  return stagger(h('div', { class: 'month-bar stats-controls' }, [
    seesTeam ? h('div', { class: 'segmented stats-tabs', role: 'group', 'aria-label': 'Qué ver' },
      VIEWS.map(([id, label, ico]) => h('button', { type: 'button', 'data-view': id }, [icon(ico, 'ico ico-xs'), h('span', { text: label })]))) : null,
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Periodo' },
      PERIODS.map(([id, label]) => h('button', { type: 'button', 'data-period': id, text: label }))),
    h('label', { class: 'switch' }, [
      h('input', { type: 'checkbox', 'data-simulate': '' }),
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
      h('span', { class: 'switch-text' }, [h('strong', { text: 'Simular datos' }), h('small', { text: 'Ventas de ejemplo hasta que funcione el TPV' })]),
    ]),
    h('div', { class: 'targets-chip', 'data-targets': '' }),
    isAdmin ? h('button', { class: 'month-today', type: 'button', 'data-edit-targets': '', text: 'Cambiar objetivos' }) : null,
    seesTeam ? exportButton({ title: 'Ventas del periodo en Excel (cada ticket, por día y por empleado)' }) : null,
  ]), 2);
}

function syncControls() {
  const root = state.els.root;
  root.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
  root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  root.querySelector('[data-simulate]').checked = state.simulate;
  // Los del mes en curso (si tiene objetivo propio, ya ajustados).
  const t = state.data?.currentTargets ?? state.data?.targets;
  if (t) {
    const propio = t.monthlyCents !== state.data.targets?.monthlyCents;
    root.querySelector('[data-targets]').replaceChildren(
      icon('chart', 'ico ico-sm'),
      h('span', {}, [
        h('strong', { text: propio ? 'Objetivo de este mes: ' : 'Objetivo: ' }),
        h('span', { text: `${eurosShort(t.dailyCents)} / día · ${eurosShort(t.weeklyCents)} / semana · ${eurosShort(t.monthlyCents)} / mes` }),
      ]),
    );
  }
}

/* ---------- Piezas de la pantalla ---------- */

function card(title, subtitle, body, extra = '') {
  return h('section', { class: `stat-card ${extra}` }, [
    h('header', { class: 'stat-card-head' }, [h('h2', { text: title }), subtitle ? h('p', { text: subtitle }) : null]),
    body,
  ]);
}

function meter(value, target) {
  const ratio = target ? Math.min(1, value / target) : 0;
  const bar = h('span', { class: `meter-fill${value >= target ? ' is-met' : ''}` });
  bar.style.setProperty('--fill', String(ratio));
  return h('span', { class: 'meter', role: 'presentation' }, bar);
}

function kpiTile(label, value, target) {
  const met = value >= target;
  return h('div', { class: 'kpi' }, [
    h('span', { class: 'kpi-label', text: label }),
    h('span', { class: 'kpi-value', text: formatEuros(value) }),
    meter(value, target),
    h('span', { class: `kpi-detail${met ? ' is-met' : ''}` }, met
      ? [icon('shield', 'ico ico-xs'), h('span', { text: `Objetivo cumplido (${eurosShort(target)})` })]
      : [h('span', { text: `Faltan ${formatEuros(target - value)} · ${pct.format(target ? value / target : 0)} de ${eurosShort(target)}` })]),
  ]);
}

function kpis() {
  const { kpis: k } = state.data;
  return h('div', { class: 'kpis' }, [
    kpiTile('Hoy', k.today.cents, k.today.targetCents),
    kpiTile('Esta semana', k.week.cents, k.week.targetCents),
    kpiTile('Este mes', k.month.cents, k.month.targetCents),
    h('div', { class: 'kpi kpi-total' }, [
      h('span', { class: 'kpi-label', text: `Total · ${periodLabel()}` }),
      h('span', { class: 'kpi-value', text: formatEuros(k.total.cents) }),
      h('span', { class: 'kpi-detail', text: `${count.format(k.total.tickets)} ventas · ticket medio ${formatEuros(k.total.avgTicketCents)} · ${k.total.openDays} días abiertos` }),
      k.vouchers?.count ? h('span', { class: 'kpi-detail', text: `Aparte: ${formatEuros(k.vouchers.cents)} en vales (${count.format(k.vouchers.count)}), que no suman` }) : null,
    ]),
  ]);
}

function goalTile(label, unit, goal) {
  const ratio = goal.total ? goal.met / goal.total : 0;
  const ring = h('span', { class: 'goal-ring', 'aria-hidden': 'true' });
  ring.style.setProperty('--ratio', String(ratio));
  return h('div', { class: 'goal' }, [
    ring,
    h('span', { class: 'goal-text' }, [
      h('span', { class: 'kpi-label', text: label }),
      h('span', { class: 'goal-value', text: goal.total ? pct.format(ratio) : '—' }),
      h('span', { class: 'kpi-detail', text: goal.total ? `${goal.met} de ${goal.total} ${unit} cumplen el objetivo` : `Aún no hay ${unit} completos` }),
    ]),
  ]);
}

function goals() {
  const { goals: g } = state.data;
  return h('div', { class: 'goals' }, [
    goalTile('Días que se cumple', 'días', g.days),
    goalTile('Semanas que se cumple', 'semanas', g.weeks),
    goalTile('Meses que se cumple', 'meses', g.months),
  ]);
}

function legend(items) {
  return h('ul', { class: 'chart-legend' }, items.map(([cls, label]) => h('li', {}, [h('span', { class: `legend-swatch ${cls}`, 'aria-hidden': 'true' }), h('span', { text: label })])));
}

function methodsBlock() {
  const total = state.data.methods.reduce((t, m) => t + m.cents, 0);
  const donut = h('div', { class: 'donut-wrap' });
  const list = h('ul', { class: 'method-list' }, METHODS.map((m) => {
    const row = state.data.methods.find((x) => x.id === m.id);
    // Los vales vienen de devoluciones ya contadas: se ven, pero no suman.
    const detail = row.revenue === false
      ? `${count.format(row.count)} pagos · no suman a ventas`
      : `${pct.format(row.share)} · ${count.format(row.count)} ventas`;
    return h('li', { class: row.revenue === false ? 'is-excluded' : null }, [
      h('span', { class: `legend-swatch series-${m.slot}`, 'aria-hidden': 'true' }),
      h('span', { class: 'method-name', text: m.label }),
      h('span', { class: 'method-amount' }, [h('strong', { text: formatEuros(row.cents) }), h('small', { text: detail })]),
    ]);
  }));
  return { node: h('div', { class: 'methods' }, [donut, list]), donut, total };
}

function shiftsBlock() {
  const { manana, tarde } = state.data.shifts;
  const total = manana.cents + tarde.cents;
  const split = h('div', { class: 'shift-split', role: 'img', 'aria-label': `Mañana ${pct.format(total ? manana.cents / total : 0)}, tarde ${pct.format(total ? tarde.cents / total : 0)}` }, [
    h('span', { class: 'shift-am' }),
    h('span', { class: 'shift-pm' }),
  ]);
  split.style.setProperty('--am', String(total ? manana.cents / total : 0.5));
  const tile = (name, s, cls) => h('div', { class: `shift ${cls}` }, [
    h('span', { class: 'kpi-label', text: name }),
    h('span', { class: 'kpi-value', text: formatEuros(s.cents) }),
    h('span', { class: 'kpi-detail', text: `${pct.format(total ? s.cents / total : 0)} · ${count.format(s.tickets)} ventas · ticket medio ${formatEuros(s.tickets ? Math.round(s.cents / s.tickets) : 0)}` }),
    h('span', { class: 'shift-wins' }, [h('strong', { text: String(s.daysWon) }), h('span', { text: ' días gana' })]),
  ]);
  return h('div', { class: 'shifts' }, [
    h('div', { class: 'shift-tiles' }, [tile(`Mañana (${manana.start}–${manana.end})`, manana, 'is-am'), tile(`Tarde (${tarde.start}–${tarde.end})`, tarde, 'is-pm')]),
    split,
  ]);
}

function historyTable() {
  const rows = [...state.data.monthly].reverse();
  return h('div', { class: 'history-scroll' }, h('table', { class: 'history' }, [
    h('thead', {}, h('tr', {}, ['Mes', 'Ventas', 'Gastos', 'Beneficio', 'Objetivo'].map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, rows.map((m) => h('tr', {}, [
      h('th', { scope: 'row', text: monthLabel(m.month) }),
      h('td', { class: 'num', text: formatEuros(m.salesCents) }),
      h('td', { class: 'num', text: formatEuros(m.expensesCents) }),
      h('td', { class: `num ${m.profitCents >= 0 ? 'is-good' : 'is-bad'}`, text: `${m.profitCents >= 0 ? '+' : '−'}${formatEuros(Math.abs(m.profitCents))}` }),
      h('td', {}, h('span', { class: `goal-badge ${!m.complete ? 'is-open' : m.targetMet ? 'is-met' : 'is-miss'}`, text: !m.complete ? 'En curso' : m.targetMet ? '✓ Cumplido' : '✗ No llegó' })),
    ]))),
  ]));
}

/* ---------- Beneficio ---------- */

/** «+1.234 €» / «−567 €» (sin céntimos, para las etiquetas del gráfico). */
const signedEuros = (cents) => `${cents >= 0 ? '+' : '−'}${eurosShort(Math.abs(cents))}`;

function profitSummary() {
  const months = state.data.monthly;
  const sales = months.reduce((t, m) => t + m.salesCents, 0);
  const expenses = months.reduce((t, m) => t + m.expensesCents, 0);
  const profit = sales - expenses;
  const active = months.filter((m) => m.salesCents || m.expensesCents);
  const gains = active.filter((m) => m.profitCents > 0).length;
  const tile = (label, value, extra = '') => h('div', { class: `profit-tile ${extra}` }, [h('span', { class: 'kpi-label', text: label }), h('span', { class: 'profit-value', text: value })]);
  return h('div', { class: 'profit-summary' }, [
    tile(`${profit >= 0 ? 'Beneficio' : 'Pérdida'} total · ${periodLabel()}`, `${profit >= 0 ? '+' : '−'}${formatEuros(Math.abs(profit))}`, profit >= 0 ? 'is-gain is-main' : 'is-loss is-main'),
    tile('Ventas', formatEuros(sales)),
    tile('Gastos', formatEuros(expenses)),
    tile('Margen', sales ? pct.format(profit / sales) : '—'),
    tile('Meses en positivo', active.length ? `${gains} de ${active.length}` : '—'),
  ]);
}

/* ---------- Gráficos ---------- */

function drawCharts() {
  const d = state.data;
  const c = state.els.charts;
  // La línea es el objetivo de este mes; cada barra se compara con el de su mes.
  const t = d.currentTargets ?? d.targets;
  barChart(c.daily, {
    title: 'Ventas diarias',
    format: axisEuros,
    target: { value: t.dailyCents, label: `Objetivo ${eurosShort(t.dailyCents)}` },
    bars: d.daily.map((x) => ({
      label: dayLabel(x.day),
      value: x.cents,
      tone: x.cents >= (x.targetCents ?? t.dailyCents) ? null : 'soft',
      tooltip: [`${WEEKDAYS[(new Date(`${x.day}T00:00:00Z`).getUTCDay() + 6) % 7]} ${dayLabel(x.day)}`, formatEuros(x.cents), x.tickets ? `${x.tickets} ventas` : 'Cerrado o sin ventas'],
    })),
  });
  barChart(c.weekly, {
    title: 'Ventas semanales',
    format: axisEuros,
    target: { value: t.weeklyCents, label: `Objetivo ${eurosShort(t.weeklyCents)}` },
    bars: d.weekly.map((w) => ({
      label: dayLabel(w.weekStart),
      value: w.cents,
      tone: w.cents >= (w.targetCents ?? t.weeklyCents) ? null : 'soft',
      tooltip: [`Semana del ${dayLabel(w.weekStart)}`, formatEuros(w.cents), `${count.format(w.tickets)} ventas`],
    })),
  });
  divergingBarChart(c.profit, {
    title: 'Beneficio mes a mes',
    format: (cents) => (cents < 0 ? `−${axisEuros(-cents)}` : axisEuros(cents)),
    bars: d.monthly.map((m) => ({
      label: monthShort(m.month),
      value: m.profitCents,
      mark: m.salesCents || m.expensesCents ? signedEuros(m.profitCents) : null,
      tooltip: [monthLabel(m.month), `${m.profitCents >= 0 ? 'Beneficio' : 'Pérdida'} ${formatEuros(Math.abs(m.profitCents))}`,
        `Ventas ${formatEuros(m.salesCents)} · Gastos ${formatEuros(m.expensesCents)}`,
        m.salesCents ? `Margen ${pct.format(m.profitCents / m.salesCents)}` : 'Sin ventas'],
    })),
  });
  lineChart(c.monthly, {
    title: 'Evolución de ventas y gastos mes a mes',
    format: axisEuros,
    series: [
      { name: 'Ventas', slot: 1, values: d.monthly.map((m) => m.salesCents) },
      { name: 'Gastos', slot: 2, dashed: true, values: d.monthly.map((m) => m.expensesCents) },
    ],
    labels: d.monthly.map((m) => monthShort(m.month)),
    tooltips: d.monthly.map((m) => [monthLabel(m.month), `Ventas ${formatEuros(m.salesCents)}`, `Gastos ${formatEuros(m.expensesCents)}`,
      `${m.profitCents >= 0 ? 'Beneficio' : 'Pérdida'} ${formatEuros(Math.abs(m.profitCents))}`]),
  });
  const open = d.weekdays.rows.filter((r) => r.days > 0);
  barChart(c.weekdays, {
    title: 'Media de ventas por día de la semana',
    format: axisEuros,
    height: 220,
    bars: open.map((r) => ({
      label: WEEKDAYS[r.weekday - 1],
      value: r.avgCents,
      tone: r.weekday === d.weekdays.best ? 'best' : r.weekday === d.weekdays.worst ? 'worst' : 'soft',
      mark: r.weekday === d.weekdays.best ? 'Mejor' : r.weekday === d.weekdays.worst ? 'Más flojo' : null,
      tooltip: [WEEKDAYS[r.weekday - 1], `Media ${formatEuros(r.avgCents)}`, `${r.days} días con ventas`],
    })),
  });
  barChart(c.clients, {
    title: 'Clientes por semana',
    format: (v) => String(Math.round(v)),
    height: 220,
    bars: d.weekly.map((w) => ({ label: dayLabel(w.weekStart), value: w.tickets, tone: 'clients', tooltip: [`Semana del ${dayLabel(w.weekStart)}`, `${w.tickets} clientes (ventas)`] })),
  });
  // Las ventas de la caja diaria van por turno, sin hora: las franjas llegan con el TPV.
  if (!d.hours.rows.length) {
    c.hours.replaceChildren(h('p', { class: 'notice', text: d.hours.fromDailyTotals
      ? 'Las ventas de la caja diaria se apuntan por turno, sin hora: las franjas horarias aparecerán cuando el TPV registre cada ticket. Mañana vs tarde sí se ve arriba.'
      : 'Todavía no hay ventas con hora.' }));
  } else barChart(c.hours, {
    title: 'Ventas por franja horaria',
    format: axisEuros,
    height: 220,
    bars: d.hours.rows.map((r) => ({
      label: `${r.hour}h`,
      value: r.cents,
      tone: r.hour === d.hours.best ? 'best' : r.hour === d.hours.worst ? 'worst' : 'soft',
      mark: r.hour === d.hours.best ? 'Más ventas' : r.hour === d.hours.worst ? 'Menos' : null,
      tooltip: [`De ${r.hour}:00 a ${r.hour + 1}:00`, formatEuros(r.cents), `${count.format(r.tickets)} ventas · media ${formatEuros(r.avgPerDayCents)} por día`],
    })),
  });
  donutChart(c.methods, {
    centerLabel: 'Total ventas',
    centerValue: eurosShort(state.data.kpis.total.cents),
    segments: METHODS.filter((m) => d.methods.find((x) => x.id === m.id).revenue !== false).map((m) => {
      const row = d.methods.find((x) => x.id === m.id);
      return { slot: m.slot, value: row.cents, tooltip: [m.label, formatEuros(row.cents), `${pct.format(row.share)} · ${count.format(row.count)} ventas`] };
    }),
  });
}

/* ---------- Pantalla ---------- */

function periodLabel() {
  return PERIODS.find(([id]) => id === state.period)[1].toLowerCase();
}

/** Aviso cuando el periodo empieza en el día en que la tienda pasó a ser nuestra. */
function startNote() {
  const d = state.data;
  if (!d.businessStart || d.period?.from !== d.businessStart) return null;
  return h('p', { class: 'notice notice-start' }, [icon('calendar', 'ico ico-sm'), h('span', {
    text: `Desde el ${d.businessStart.split('-').reverse().join('/')}, cuando la tienda pasó a ser vuestra: lo anterior era del dueño anterior y no cuenta.`,
  })]);
}

function notice() {
  if (state.data.simulated) {
    return h('p', { class: 'notice notice-sim' }, [icon('magic', 'ico ico-sm'), h('span', { text: 'Datos simulados: así se verá cuando el TPV registre las ventas. Los gastos también son de ejemplo.' })]);
  }
  if (state.data.hours?.fromDailyTotals) {
    return h('p', { class: 'notice' }, [icon('coin', 'ico ico-sm'), h('span', { text: 'Ventas reales de la caja diaria (Ventas › Caja diaria): por día, turno y método; los clientes son los apuntados en cada turno.' })]);
  }
  if (!state.data.hasRealSales) {
    return h('p', { class: 'notice' }, [icon('chart', 'ico ico-sm'), h('span', { text: 'Todavía no hay ventas registradas: apúntalas en Ventas › Caja diaria (o importa las de la app antigua). Activa «Simular datos» para ver cómo quedará.' })]);
  }
  return null;
}

function render() {
  syncControls();
  if (state.view === 'empleados') {
    state.drawStaff = renderStaffView(state.els.body, state.data, { card });
    state.drawStaff();
    return;
  }
  state.drawStaff = null;
  const methods = methodsBlock();
  const charts = {
    daily: h('div', { class: 'chart-box' }),
    weekly: h('div', { class: 'chart-box' }),
    monthly: h('div', { class: 'chart-box' }),
    profit: h('div', { class: 'chart-box' }),
    weekdays: h('div', { class: 'chart-box' }),
    clients: h('div', { class: 'chart-box' }),
    hours: h('div', { class: 'chart-box' }),
    methods: methods.donut,
  };
  state.els.charts = charts;
  state.els.body.replaceChildren(
    notice(),
    startNote(),
    kpis(),
    goals(),
    h('div', { class: 'stat-grid' }, [
      card('Ventas diarias', 'Últimos 30 días. Más claras, las que no llegan al objetivo.', charts.daily, 'is-wide'),
      card('Ventas semanales', 'Cada barra es una semana de lunes a domingo.', charts.weekly),
      card('Evolución de ventas y gastos', 'Mes a mes. Los gastos salen de la tabla de Gastos (los tres tipos, cada factura de proveedor en el mes de su vencimiento).',
        h('div', {}, [legend([['series-1 is-line', 'Ventas'], ['series-2 is-line is-dashed', 'Gastos']]), charts.monthly]), 'is-wide'),
      card('Beneficio mes a mes', 'Ventas (sin vales) menos gastos de cada mes. En verde, los meses con beneficio; en rojo, con pérdidas.',
        h('div', {}, [profitSummary(), charts.profit]), 'is-wide'),
      card('Métodos de pago', `Reparto del total vendido en ${periodLabel()}. Los vales se muestran aparte: vienen de devoluciones y no suman.`, methods.node),
      card('Media por día de la semana', 'Suma de cada día dividida entre los días abiertos (sin cierres ni festivos).', charts.weekdays),
      card('Clientes por semana', 'Número de ventas (tickets) de cada semana.', charts.clients),
      card('Mañana vs tarde', 'Cuánto se vende en cada turno y cuántos días gana cada uno.', shiftsBlock()),
      card('Ventas por franja horaria', 'Total de cada hora en el periodo.', charts.hours, 'is-wide'),
    ]),
    card('Histórico mensual', 'Ventas, gastos y beneficio de cada mes del periodo.', historyTable(), 'is-table'),
  );
  drawCharts();
}

function query() {
  return `periodo=${state.period}${state.simulate ? '&simular=1' : ''}`;
}

async function load() {
  const path = state.view === 'empleados' ? '/api/estadisticas/empleados' : '/api/estadisticas';
  const [res, targets] = await Promise.all([
    api('GET', `${path}?${query()}`),
    // La franja de objetivos se mantiene también en la pestaña de empleados.
    state.view === 'empleados' ? api('GET', '/api/estadisticas/objetivos') : null,
  ]);
  if (!res.ok) return void showToast(res.error, { tone: 'error' });
  state.data = targets?.ok ? { ...res.data, targets: targets.data } : res.data;
  history.replaceState(history.state, '', `${BASE_PATH}?${state.view === 'empleados' ? 'vista=empleados&' : ''}${query()}`);
  return void render();
}

const MONTH_NAMES = Object.freeze(['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']);
const FIRST_TARGET_YEAR = 2026;
const YEARS_AHEAD = 2;
const GENERAL = 'general';
// Un mes de objetivo son 24 días de tienda y una semana, 6: 500 €/día = 3.000 €/semana = 12.000 €/mes.
const DAYS = Object.freeze({ daily: 1, weekly: 6, monthly: 24 });
const TARGET_KEYS = Object.freeze({ daily: 'dailyCents', weekly: 'weeklyCents', monthly: 'monthlyCents' });

/** «1.250,50» / «625» → céntimos (null si no es un importe). */
function inputToCents(text) {
  let s = String(text ?? '').replace(/[\s€]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/**
 * Ventana de objetivos: se elige año y mes (o «por defecto», para los meses
 * sin objetivos propios) y se escribe el diario, el semanal o el mensual; los
 * otros dos se calculan solos. Guardar solo cambia ese mes.
 */
async function editTargets() {
  const t = { ...state.data.targets, byMonth: { ...(state.data.targets.byMonth ?? {}) } };
  const now = new Date();
  const years = [];
  for (let y = FIRST_TARGET_YEAR; y <= now.getFullYear() + YEARS_AHEAD; y += 1) years.push(y);
  const yearSel = h('select', { name: 'anio', 'aria-label': 'Año' }, years.map((y) => h('option', { value: String(y), text: String(y), selected: y === now.getFullYear() })));
  const monthSel = h('select', { name: 'mes', 'aria-label': 'Mes' });
  const inputs = Object.fromEntries(Object.keys(DAYS).map((k) => [k, h('input', { type: 'text', inputmode: 'decimal', name: k, autocomplete: 'off' })]));
  const status = h('p', { class: 'targets-status' });
  const resetBtn = h('button', { type: 'button', class: 'btn-text targets-reset', text: 'Quitar los de este mes (usar los de por defecto)' });

  const key = () => (monthSel.value === GENERAL ? GENERAL : `${yearSel.value}-${monthSel.value}`);
  const current = () => (key() === GENERAL ? t : t.byMonth[key()] ?? t);
  const fillMonths = (selected) => {
    monthSel.replaceChildren(
      h('option', { value: GENERAL, text: 'Por defecto (meses sin objetivos propios)' }),
      ...MONTH_NAMES.map((name, i) => {
        const value = String(i + 1).padStart(2, '0');
        const own = t.byMonth[`${yearSel.value}-${value}`];
        return h('option', { value, text: own ? `${name} · ${eurosShort(own.monthlyCents)} / mes` : name });
      }),
    );
    monthSel.value = selected;
  };
  const fill = () => {
    const c = current();
    for (const [k, input] of Object.entries(inputs)) input.value = centsToInput(c[TARGET_KEYS[k]]);
    const own = key() !== GENERAL && Boolean(t.byMonth[key()]);
    status.textContent = key() === GENERAL
      ? 'Valen para todos los meses que no tengan objetivos propios.'
      : own ? 'Este mes tiene sus propios objetivos.' : 'Este mes usa los de por defecto: si guardas, tendrá los suyos.';
    resetBtn.hidden = !own;
  };
  // Escribir uno calcula los otros dos (sin tocar el que se está escribiendo).
  for (const [k, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => {
      const cents = inputToCents(input.value);
      if (cents === null) return;
      const perDay = cents / DAYS[k];
      for (const [other, el] of Object.entries(inputs)) {
        if (other !== k) el.value = centsToInput(Math.round(perDay * DAYS[other]));
      }
    });
  }
  yearSel.addEventListener('change', () => { fillMonths(monthSel.value); fill(); });
  monthSel.addEventListener('change', fill);
  resetBtn.addEventListener('click', async () => {
    const res = await api('DELETE', `/api/estadisticas/objetivos/mes/${key()}`);
    if (!res.ok) return void showToast(res.error, { tone: 'error' });
    t.byMonth = res.data.byMonth;
    fillMonths(monthSel.value);
    fill();
    showToast('Ese mes vuelve a usar los objetivos por defecto.');
  });
  fillMonths(String(now.getMonth() + 1).padStart(2, '0'));
  fill();

  // Misma forma que los campos de los diálogos: etiqueta encima, unida por id.
  const label = (text, el) => {
    el.id = `obj-${el.name}`;
    return h('div', { class: 'field' }, [h('label', { for: el.id, text }), el]);
  };
  const saved = await openDialog({
    eyebrow: 'Objetivos de venta',
    title: 'Cambiar los objetivos',
    lead: 'Elige el mes y escribe el objetivo diario, semanal o mensual: los otros dos se calculan solos (un mes = 24 días, una semana = 6). Solo cambia el mes elegido.',
    content: h('div', { class: 'targets-form' }, [
      h('div', { class: 'targets-when' }, [label('Año', yearSel), label('Mes', monthSel)]),
      label('Diario (€)', inputs.daily),
      label('Semanal (€)', inputs.weekly),
      label('Mensual (€)', inputs.monthly),
      h('div', { class: 'targets-foot' }, [status, resetBtn]),
    ]),
    submitLabel: 'Guardar objetivos',
    onSubmit: async () => {
      const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      const path = key() === GENERAL ? '/api/estadisticas/objetivos' : `/api/estadisticas/objetivos/mes/${key()}`;
      const res = await api('PUT', path, body);
      return res.ok ? true : { error: res.error };
    },
  });
  if (!saved) return;
  showToast('Objetivos guardados.');
  await load();
}

function bindEvents(root) {
  root.addEventListener('click', (event) => {
    const view = event.target.closest('[data-view]');
    if (view && view.dataset.view !== state.view) {
      state.view = view.dataset.view;
      state.els.body.replaceChildren(h('p', { class: 'notice', text: 'Cargando…' }));
      load();
      return;
    }
    const period = event.target.closest('[data-period]');
    if (period) {
      state.period = period.dataset.period;
      load();
    } else if (event.target.closest('[data-edit-targets]')) {
      editTargets();
    } else if (event.target.closest('[data-export]')) {
      download(`/api/estadisticas/exportar?${query()}`);
    }
  });
  root.addEventListener('change', (event) => {
    if (!event.target.matches('[data-simulate]')) return;
    state.simulate = event.target.checked;
    load();
  });
  // Los gráficos se dibujan al ancho disponible: se rehacen al cambiar el tamaño.
  state.resize?.disconnect();
  let frame = 0;
  state.resize = new ResizeObserver(() => {
    clearTimeout(frame);
    frame = setTimeout(() => {
      if (!state.data || !root.isConnected) return;
      if (state.drawStaff) state.drawStaff();
      else drawCharts();
    }, 120);
  });
  state.resize.observe(root);
}

/** Pinta Estadísticas. Admite ?periodo=3m|6m|12m|anio, ?simular=1 y ?vista=empleados. */
export function renderStats({ main, user, params, backHref }) {
  state.user = user;
  state.view = ['admin', 'asesor'].includes(user.role) && params.get('vista') === 'empleados' ? 'empleados' : 'tienda';
  state.period = PERIODS.some(([id]) => id === params.get('periodo')) ? params.get('periodo') : DEFAULT_PERIOD;
  state.simulate = params.get('simular') === '1';
  const body = h('div', { class: 'stats-body' }, h('p', { class: 'notice', text: 'Cargando estadísticas…' }));
  const root = h('div', { class: 'recurring stats-view' }, [header(backHref), controls(), stagger(body, 3)]);
  state.els = { root, body };
  bindEvents(root);
  main.replaceChildren(root);
  document.title = 'Estadísticas · Puntapié';
  load();
  return root.querySelector('h1');
}
