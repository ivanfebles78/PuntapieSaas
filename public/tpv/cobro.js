import { api } from '../api.js';
import { openDialog } from '../dialogs.js';
import { h } from '../dom.js';
import { formatEuros } from '../format.js';
import { centToEur, eurToCent } from '../proveedores/util.js';

// Cobro de una venta: uno o varios métodos (p. ej. 20 € con vale y el resto
// con tarjeta). En efectivo se escribe lo entregado y sale el cambio; con
// vale se escanea su QR y se usa su saldo.

const METODOS = Object.freeze([['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['bizum', 'Bizum'], ['bonos', 'Bonos'], ['vales', 'Vale']]);
const BILLETES = Object.freeze([500, 1000, 2000, 5000, 10000]);

/** Abre el cobro de `total` céntimos. Resuelve la lista de pagos o null si se cancela. */
export function cobrar(total) {
  let pagos = [];
  const falta = () => total - pagos.reduce((s, p) => s + (p.importe ?? 0), 0);
  const resumen = h('div', { class: 'cobro-resumen' });
  const filas = h('div', { class: 'cobro-filas' });
  const metodos = h('div', { class: 'cobro-metodos', role: 'group', 'aria-label': 'Añadir un método de pago' },
    METODOS.map(([id, nombre]) => h('button', { type: 'button', class: `cobro-metodo cm-${id}`, 'data-metodo': id, text: nombre })));

  function pintarResumen() {
    const f = falta();
    const efectivo = pagos.find((p) => p.metodo === 'efectivo');
    const cambio = efectivo?.entregado != null && efectivo.importe != null ? efectivo.entregado - efectivo.importe : 0;
    resumen.replaceChildren(
      h('div', {}, [h('span', { text: 'Total' }), h('strong', { text: formatEuros(total) })]),
      h('div', { class: f === 0 ? 'is-ok' : 'is-falta' }, [h('span', { text: f >= 0 ? 'Falta' : 'Sobra' }), h('strong', { text: formatEuros(Math.abs(f)) })]),
      cambio > 0 ? h('div', { class: 'is-cambio' }, [h('span', { text: 'Cambio' }), h('strong', { text: formatEuros(cambio) })]) : '',
    );
  }

  function filaPago(p, i) {
    const nombre = METODOS.find(([id]) => id === p.metodo)[1];
    const importe = h('input', { class: 'cobro-importe', inputmode: 'decimal', value: centToEur(p.importe), 'data-i': String(i), 'data-campo': 'importe', 'aria-label': `Importe en ${nombre}` });
    const extra = p.metodo === 'efectivo' ? h('div', { class: 'cobro-efectivo' }, [
      h('label', {}, [h('span', { text: 'Entregado' }), h('input', { class: 'cobro-importe', inputmode: 'decimal', value: centToEur(p.entregado), 'data-i': String(i), 'data-campo': 'entregado', 'aria-label': 'Efectivo entregado' })]),
      h('div', { class: 'cobro-billetes' }, [
        h('button', { type: 'button', 'data-i': String(i), 'data-billete': 'justo', text: 'Justo' }),
        ...BILLETES.filter((b) => b >= (p.importe ?? 0) || b === 10000).map((b) => h('button', { type: 'button', 'data-i': String(i), 'data-billete': String(b), text: formatEuros(b).replace(',00', '') })),
      ]),
    ]) : p.metodo === 'vales' ? h('div', { class: 'cobro-vale' }, [
      h('input', {
        class: 'cobro-codigo', value: p.vale ?? '', autocomplete: 'off', spellcheck: 'false', placeholder: 'Escanea el QR del vale',
        'data-i': String(i), 'data-campo': 'vale', 'aria-label': 'Código del vale',
      }),
      h('span', { class: `cobro-vale-info${p.error ? ' is-error' : ''}`, text: p.error ?? p.info ?? '' }),
    ]) : null;
    return h('div', { class: 'cobro-fila' }, [
      h('strong', { text: nombre }),
      importe,
      h('button', { type: 'button', class: 'cobro-quitar', 'data-quitar': String(i), 'aria-label': `Quitar ${nombre}`, text: '✕' }),
      extra,
    ]);
  }

  function pintar() {
    filas.replaceChildren(...pagos.map(filaPago));
    pintarResumen();
  }

  const contenido = h('div', { class: 'cobro' }, [resumen, metodos, filas]);
  contenido.addEventListener('click', (e) => {
    const m = e.target.closest('[data-metodo]');
    if (m?.dataset.metodo === 'vales') {
      // Cada vale va en su fila: se escanea y se usa su saldo (hasta lo que falte).
      pagos = [...pagos, { metodo: 'vales', importe: null, vale: null, info: null, error: null }];
      pintar();
      filas.querySelector(`[data-i="${pagos.length - 1}"][data-campo=vale]`)?.focus();
      return;
    }
    if (m) {
      const ya = pagos.find((p) => p.metodo === m.dataset.metodo);
      const resto = Math.max(falta(), 0);
      if (ya) ya.importe = (ya.importe ?? 0) + resto;
      else pagos = [...pagos, { metodo: m.dataset.metodo, importe: resto || null, entregado: null }];
      pintar();
      const ultimo = filas.querySelector(`[data-i="${pagos.findIndex((p) => p.metodo === m.dataset.metodo)}"][data-campo=${m.dataset.metodo === 'efectivo' ? 'entregado' : 'importe'}]`);
      ultimo?.focus();
      return;
    }
    const q = e.target.closest('[data-quitar]');
    if (q) {
      pagos = pagos.filter((_, i) => i !== Number(q.dataset.quitar));
      pintar();
      return;
    }
    const b = e.target.closest('[data-billete]');
    if (b) {
      const p = pagos[Number(b.dataset.i)];
      p.entregado = b.dataset.billete === 'justo' ? p.importe : Number(b.dataset.billete);
      pintar();
    }
  });
  // La pistola escribe el código del vale y pulsa Intro: se consulta su saldo (sin enviar el cobro).
  contenido.addEventListener('keydown', async (e) => {
    const campo = e.target.closest('[data-campo=vale]');
    if (!campo || e.key !== 'Enter') return;
    e.preventDefault();
    const i = Number(campo.dataset.i);
    const p = pagos[i];
    const res = await api('GET', `/api/tpv/vales/${encodeURIComponent(campo.value.trim())}`);
    p.vale = null;
    p.info = null;
    p.error = null;
    if (!res.ok) p.error = res.error;
    else if (pagos.some((x, j) => j !== i && x.vale === res.data.codigo)) p.error = 'Ese vale ya está en el cobro.';
    else if (res.data.estado !== 'activo') p.error = `Vale ${res.data.codigo_legible}: ${res.data.estado}.`;
    else {
      p.vale = res.data.codigo;
      p.importe = Math.min(res.data.saldo_cent, Math.max(falta() + (p.importe ?? 0), 0));
      p.info = `Saldo ${formatEuros(res.data.saldo_cent)} · caduca ${res.data.caduca}`;
    }
    pintar();
  });
  contenido.addEventListener('input', (e) => {
    const campo = e.target.closest('[data-campo]');
    if (!campo || campo.dataset.campo === 'vale') return;
    const p = pagos[Number(campo.dataset.i)];
    p[campo.dataset.campo] = eurToCent(campo.value);
    pintarResumen();
  });
  pintar();

  return openDialog({
    eyebrow: 'Cobrar',
    title: formatEuros(total),
    content: contenido,
    submitLabel: 'Cobrar',
    onSubmit: async () => {
      if (!pagos.length) return { error: 'Elige cómo paga el cliente.' };
      if (pagos.some((p) => p.metodo === 'vales' && !p.vale)) return { error: 'Escanea el QR de cada vale (y pulsa Intro si lo escribes a mano).' };
      if (pagos.some((p) => !(p.importe > 0))) return { error: 'Cada método necesita su importe.' };
      if (falta() !== 0) return { error: falta() > 0 ? `Faltan ${formatEuros(falta())}.` : `Sobran ${formatEuros(-falta())}: revisa los importes.` };
      const ef = pagos.find((p) => p.metodo === 'efectivo');
      if (ef?.entregado != null && ef.entregado < ef.importe) return { error: 'El efectivo entregado no llega a su importe.' };
      return pagos.map((p) => ({ metodo: p.metodo, importe_cent: p.importe, entregado_cent: p.metodo === 'efectivo' ? p.entregado : null, vale: p.vale ?? null }));
    },
  });
}
