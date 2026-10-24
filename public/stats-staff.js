import { barChart } from './charts.js';
import { h } from './dom.js';
import { formatEuros } from './format.js';
import { icon } from './icons.js';

// Estadísticas › Empleados. Cada persona se lleva el total de los turnos en
// los que estaba; se compara la venta media por turno y un índice frente a la
// media de la tienda en los mismos turnos (100 % = lo normal).

const count = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });
const pct = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 0 });
const euros0 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' });
const eurosShort = (cents) => euros0.format(cents / 100);

/** «+12 % sobre la media» / «−8 % bajo la media» / «En la media». */
export function indexText(index) {
  if (index === null) return 'Sin turnos con ventas';
  const diff = Math.round((index - 1) * 100);
  if (diff === 0) return 'En la media de la tienda';
  return diff > 0 ? `+${diff} % sobre la media` : `−${-diff} % bajo la media`;
}

function notices(d) {
  const list = [];
  if (d.simulated) {
    list.push(d.simulatedTeam
      ? 'Ventas y turnos de ejemplo: aún no hay turnos definidos, así que se reparten entre el equipo activo.'
      : 'Ventas simuladas repartidas según los turnos reales del equipo.');
  } else if (!d.hasRealSales) {
    list.push('Todavía no hay ventas registradas: llegarán con el TPV. Activa «Simular datos» para ver cómo quedará.');
  }
  if (!d.hasSchedules && !d.simulatedTeam) list.push('Define el turno de cada persona en Admin › Usuarios › Turno para poder atribuirle las ventas.');
  if (d.store.unstaffedShifts) list.push(`${d.store.unstaffedShifts} turnos con ventas no tienen a nadie asignado y no cuentan para nadie.`);
  return list.map((text, i) => h('p', { class: `notice${i === 0 && d.simulated ? ' notice-sim' : ''}` }, [icon(d.simulated && i === 0 ? 'magic' : 'people', 'ico ico-sm'), h('span', { text })]));
}

function podiumCard(row, kind) {
  if (!row) return null;
  const best = kind === 'best';
  return h('div', { class: `podium ${best ? 'is-best' : 'is-worst'}` }, [
    h('span', { class: 'podium-tag' }, [icon(best ? 'crown' : 'chart', 'ico ico-xs'), h('span', { text: best ? 'Vende más' : 'Vende menos' })]),
    h('span', { class: 'podium-name', text: row.name }),
    h('span', { class: 'podium-index', text: indexText(row.index) }),
    h('span', { class: 'kpi-detail', text: `${eurosShort(row.avgPerShiftCents)} de media por turno · ${row.shifts} turnos` }),
  ]);
}

function staffTable(d) {
  const shiftCell = (r, shift) => (r.byShift[shift].shifts
    ? h('td', { class: 'num' }, [h('span', { text: formatEuros(r.byShift[shift].avgCents) }), h('small', { text: ` · ${r.byShift[shift].shifts}` })])
    : h('td', { class: 'num log-none', text: '—' }));
  return h('div', { class: 'history-scroll' }, h('table', { class: 'history staff-table' }, [
    h('thead', {}, h('tr', {}, ['Empleado', 'Turnos', 'Ventas en sus turnos', 'Media por turno', 'Mañanas', 'Tardes', 'Frente a la tienda']
      .map((t) => h('th', { scope: 'col', text: t })))),
    h('tbody', {}, d.rows.map((r) => h('tr', { class: r.id === d.best ? 'is-best' : r.id === d.worst ? 'is-worst' : null }, [
      h('th', { scope: 'row' }, [
        h('span', { text: r.name }),
        r.active ? null : h('small', { class: 'staff-off', text: ' (de baja)' }),
        r.ranked ? null : h('small', { class: 'staff-off', text: ` · menos de ${d.minShiftsToRank} turnos` }),
      ]),
      h('td', { class: 'num', text: count.format(r.shifts) }),
      h('td', { class: 'num', text: formatEuros(r.cents) }),
      h('td', { class: 'num', text: formatEuros(r.avgPerShiftCents) }),
      shiftCell(r, 'manana'),
      shiftCell(r, 'tarde'),
      h('td', {}, h('span', { class: `goal-badge ${r.index === null ? 'is-open' : r.index >= 1 ? 'is-met' : 'is-miss'}`, text: r.index === null ? '—' : `${pct.format(r.index)}` })),
    ]))),
  ]));
}

/**
 * Pinta la pestaña. `card` es el contenedor de tarjeta de la vista general.
 * Devuelve la función que (re)dibuja el gráfico al ancho disponible.
 */
export function renderStaffView(body, d, { card }) {
  const chart = h('div', { class: 'chart-box' });
  const byId = new Map(d.rows.map((r) => [r.id, r]));
  const storeAvg = d.store.shifts
    ? Math.round((d.store.byShift.manana.avgCents * d.store.byShift.manana.shifts + d.store.byShift.tarde.avgCents * d.store.byShift.tarde.shifts) / d.store.shifts)
    : 0;
  body.replaceChildren(
    ...notices(d),
    d.rows.length ? h('div', { class: 'podiums' }, [
      podiumCard(byId.get(d.best), 'best'),
      podiumCard(byId.get(d.worst), 'worst'),
      h('div', { class: 'podium is-store' }, [
        h('span', { class: 'podium-tag' }, [icon('shop', 'ico ico-xs'), h('span', { text: 'Media de la tienda' })]),
        h('span', { class: 'podium-name', text: eurosShort(storeAvg) }),
        h('span', { class: 'podium-index', text: 'por turno abierto' }),
        h('span', { class: 'kpi-detail', text: `Mañana ${eurosShort(d.store.byShift.manana.avgCents)} · tarde ${eurosShort(d.store.byShift.tarde.avgCents)} · ${count.format(d.store.shifts)} turnos` }),
      ]),
    ]) : null,
    d.rows.length ? h('div', { class: 'stat-grid' }, [
      card('Venta media por turno', 'Lo que vende la tienda, de media, en los turnos en los que está cada persona.', chart, 'is-wide'),
    ]) : null,
    d.rows.length
      ? card('Comparativa del equipo', 'Ordenado de más a menos frente a la media de la tienda en los mismos turnos (la tarde vende más que la mañana, así que se compara cada turno con los de su tipo). Si coinciden dos personas, el turno cuenta para las dos.', staffTable(d), 'is-table')
      : null,
  );

  return () => {
    if (!d.rows.length || !chart.isConnected) return;
    barChart(chart, {
      title: 'Venta media por turno de cada empleado',
      format: (cents) => count.format(Math.round(cents / 100)),
      height: 240,
      target: { value: storeAvg, label: `Media tienda ${eurosShort(storeAvg)}` },
      bars: d.rows.filter((r) => r.shifts > 0).map((r) => ({
        label: r.name.split(' ')[0],
        value: r.avgPerShiftCents,
        tone: r.id === d.best ? 'best' : r.id === d.worst ? 'worst' : 'soft',
        mark: r.id === d.best ? 'Más' : r.id === d.worst ? 'Menos' : null,
        tooltip: [r.name, `${formatEuros(r.avgPerShiftCents)} de media por turno`, `${r.shifts} turnos · ${formatEuros(r.cents)}`, indexText(r.index)],
      })),
    });
  };
}
