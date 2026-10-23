// Gráficos SVG propios (la CSP no permite librerías externas). Siguen las
// reglas de la guía de visualización: marcas finas con 4 px redondeados en la
// punta, 2 px de hueco entre barras, rejilla en línea fina, un solo eje Y,
// etiquetas directas solo en lo importante y tooltip al pasar o enfocar.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 22, right: 12, bottom: 30, left: 52 };
const BAR_RADIUS = 4;
const MIN_LABEL_GAP = 46;

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const child of [].concat(children)) if (child) el.append(child);
  return el;
}

function text(x, y, value, attrs = {}) {
  const el = svg('text', { x, y, ...attrs });
  el.textContent = value;
  return el;
}

const MAX_TICKS = 5;

/** Máximo «redondo» para el eje, con el paso más fino que deje ≤ 5 divisiones. */
function niceScale(max) {
  if (max <= 0) return { max: 1, step: 0.25 };
  const pow = 10 ** Math.floor(Math.log10(max / MAX_TICKS));
  for (const m of [1, 2, 2.5, 5, 10, 20]) {
    const step = m * pow;
    const ticks = Math.ceil(max / step);
    if (ticks <= MAX_TICKS) return { max: step * ticks, step };
  }
  return { max, step: max / MAX_TICKS };
}

/** Barra con las dos esquinas de arriba redondeadas, apoyada en la base. */
function barPath(x, y, w, h) {
  const r = Math.min(BAR_RADIUS, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/* ---------- Tooltip compartido ---------- */

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function showTip(lines, x, y) {
  const el = tooltip();
  el.replaceChildren(...lines.map((line, i) => {
    const row = document.createElement(i === 0 ? 'strong' : 'span');
    row.textContent = line;
    return row;
  }));
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2));
  const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
  el.style.setProperty('--x', `${left + window.scrollX}px`);
  el.style.setProperty('--y', `${top + window.scrollY}px`);
}

function hideTip() {
  if (tip) tip.hidden = true;
}

/** Zona activa (más ancha que la barra) que muestra el tooltip con ratón o teclado. */
function hitArea(x, y, w, h, lines) {
  const rect = svg('rect', { x, y, width: w, height: h, class: 'chart-hit', tabindex: 0, 'aria-label': lines.join('. ') });
  const at = (event) => {
    const box = rect.getBoundingClientRect();
    showTip(lines, event?.clientX ?? box.left + box.width / 2, box.top + 8);
  };
  rect.addEventListener('pointerenter', at);
  rect.addEventListener('pointermove', at);
  rect.addEventListener('pointerleave', hideTip);
  rect.addEventListener('focus', () => at());
  rect.addEventListener('blur', hideTip);
  return rect;
}

/* ---------- Ejes ---------- */

function yAxis(width, plotH, scale, format) {
  const group = svg('g', { class: 'chart-axis' });
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = PAD.top + plotH - (v / scale.max) * plotH;
    group.append(svg('line', { x1: PAD.left, x2: width - PAD.right, y1: y, y2: y, class: v === 0 ? 'chart-base' : 'chart-grid' }));
    group.append(text(PAD.left - 8, y + 4, format(v), { 'text-anchor': 'end' }));
  }
  return group;
}

function xLabels(labels, bandX, bandW, plotBottom) {
  const every = Math.max(1, Math.ceil(MIN_LABEL_GAP / bandW));
  return svg('g', { class: 'chart-axis' }, labels.map((label, i) => (i % every === 0
    ? text(bandX(i) + bandW / 2, plotBottom + 18, label, { 'text-anchor': 'middle' })
    : null)));
}

// La etiqueta va al inicio de la línea, dentro del gráfico: así nunca se corta por la derecha.
function targetLine(width, y, label) {
  return svg('g', { class: 'chart-target' }, [
    svg('line', { x1: PAD.left, x2: width - PAD.right, y1: y, y2: y }),
    text(PAD.left + 6, y - 6, label, { 'text-anchor': 'start' }),
  ]);
}

function frame(container, height) {
  const width = Math.max(280, container.clientWidth || 640);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart', role: 'img' });
  return { width, plotW: width - PAD.left - PAD.right, plotH: height - PAD.top - PAD.bottom, root };
}

/* ---------- Barras ---------- */

/**
 * Una serie de barras. bars: [{ label, value, tooltip: string[], tone?: 'best'|'worst'|'soft', mark? }].
 * target: { value, label } dibuja la línea de objetivo.
 */
export function barChart(container, { bars, format, target, height = 230, title }) {
  const { width, plotW, plotH, root } = frame(container, height);
  root.setAttribute('aria-label', title);
  const max = Math.max(...bars.map((b) => b.value), target?.value ?? 0);
  const scale = niceScale(max * 1.08);
  const bandW = plotW / bars.length;
  const barW = Math.max(2, Math.min(bandW - 2, bandW * 0.72));
  const bandX = (i) => PAD.left + i * bandW;
  const y = (v) => PAD.top + plotH - (v / scale.max) * plotH;

  root.append(yAxis(width, plotH, scale, format));
  const marks = svg('g');
  bars.forEach((bar, i) => {
    const x = bandX(i) + (bandW - barW) / 2;
    const top = y(bar.value);
    marks.append(svg('path', { d: barPath(x, top, barW, PAD.top + plotH - top), class: `chart-bar ${bar.tone ? `is-${bar.tone}` : ''}` }));
    if (bar.mark) marks.append(text(x + barW / 2, top - 6, bar.mark, { class: 'chart-mark', 'text-anchor': 'middle' }));
  });
  root.append(marks);
  if (target) root.append(targetLine(width, y(target.value), target.label));
  root.append(xLabels(bars.map((b) => b.label), bandX, bandW, PAD.top + plotH));
  bars.forEach((bar, i) => root.append(hitArea(bandX(i), PAD.top, bandW, plotH, bar.tooltip)));
  container.replaceChildren(root);
}

/** Dos series del mismo tipo de dato (€) por grupo, lado a lado, con un único eje. */
export function groupedBarChart(container, { groups, series, format, target, height = 240, title }) {
  const { width, plotW, plotH, root } = frame(container, height);
  root.setAttribute('aria-label', title);
  const max = Math.max(...groups.flatMap((g) => g.values), target?.value ?? 0);
  const scale = niceScale(max * 1.08);
  const bandW = plotW / groups.length;
  const barW = Math.max(2, Math.min(28, (bandW * 0.78 - 2) / series.length));
  const bandX = (i) => PAD.left + i * bandW;
  const y = (v) => PAD.top + plotH - (v / scale.max) * plotH;

  root.append(yAxis(width, plotH, scale, format));
  groups.forEach((group, i) => {
    const start = bandX(i) + (bandW - (barW * series.length + 2 * (series.length - 1))) / 2;
    group.values.forEach((value, s) => {
      const top = y(value);
      root.append(svg('path', { d: barPath(start + s * (barW + 2), top, barW, PAD.top + plotH - top), class: `chart-bar series-${series[s].slot}` }));
    });
  });
  if (target) root.append(targetLine(width, y(target.value), target.label));
  root.append(xLabels(groups.map((g) => g.label), bandX, bandW, PAD.top + plotH));
  groups.forEach((group, i) => root.append(hitArea(bandX(i), PAD.top, bandW, plotH, group.tooltip)));
  container.replaceChildren(root);
}

/* ---------- Donut ---------- */

/** Parte de un todo (≤ 6 segmentos), con 2 px de hueco entre segmentos. */
export function donutChart(container, { segments, centerLabel, centerValue, size = 200 }) {
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'chart chart-donut', role: 'img', 'aria-label': centerLabel });
  const r = size / 2 - 6;
  const inner = r * 0.62;
  const cx = size / 2;
  const total = segments.reduce((t, s) => t + s.value, 0);
  let angle = -Math.PI / 2;
  const point = (rad, a) => [cx + rad * Math.cos(a), cx + rad * Math.sin(a)];
  for (const seg of segments) {
    if (!seg.value) continue;
    const sweep = (seg.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const [x1, y1] = point(r, angle);
    const [x2, y2] = point(r, end);
    const [x3, y3] = point(inner, end);
    const [x4, y4] = point(inner, angle);
    const d = sweep >= Math.PI * 2 - 1e-6
      ? `M${cx - r},${cx}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0M${cx - inner},${cx}a${inner},${inner} 0 1,1 ${2 * inner},0a${inner},${inner} 0 1,1 ${-2 * inner},0`
      : `M${x1},${y1}A${r},${r} 0 ${large},1 ${x2},${y2}L${x3},${y3}A${inner},${inner} 0 ${large},0 ${x4},${y4}Z`;
    const path = svg('path', { d, class: `chart-seg series-${seg.slot}`, tabindex: 0, 'aria-label': seg.tooltip.join('. ') });
    path.addEventListener('pointermove', (e) => showTip(seg.tooltip, e.clientX, e.clientY));
    path.addEventListener('pointerleave', hideTip);
    path.addEventListener('focus', () => {
      const box = path.getBoundingClientRect();
      showTip(seg.tooltip, box.left + box.width / 2, box.top);
    });
    path.addEventListener('blur', hideTip);
    root.append(path);
    angle = end;
  }
  root.append(text(cx, cx - 4, centerLabel, { class: 'chart-center-label', 'text-anchor': 'middle' }));
  root.append(text(cx, cx + 18, centerValue, { class: 'chart-center-value', 'text-anchor': 'middle' }));
  container.replaceChildren(root);
}

window.addEventListener('scroll', hideTip, { passive: true });
