import { emptyShift, writeDay } from '../services/daily-sales.js';
import { createExpense, ensureEntry } from '../services/expenses.js';
import { formatEuros } from '../services/money.js';

// Cómo se traduce cada registro de gestiondegastos al programa nuevo, su
// «huella» (para saber si cambió allí) y lo que se guarda en legacy_items.

const METODOS = Object.freeze({ efectivo: 'cash', tarjeta: 'card', bizum: 'bizum', bonos: 'bonos' });
const TURNOS = Object.freeze({ manana: 'morning', tarde: 'afternoon' });
const ETIQUETA_METODO = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos' });
const MAX_NOMBRE = 80;
const MAX_CLIENTES = 1000;

export const aCentimos = (n) => Math.round(Number(n ?? 0) * 100);
const clientes = (n) => Math.min(MAX_CLIENTES, Math.max(0, Math.trunc(Number(n ?? 0)) || 0));
const fechaEs = (iso) => String(iso ?? '').slice(0, 10).split('-').reverse().join('/');
const huella = (o) => JSON.stringify(o);

/* ---------- Días de caja ---------- */

/** Fila de daily_sales del antiguo → día del nuevo (sin «vales», que allí no existen). */
export function diaDelAntiguo(r) {
  const status = r.is_holiday ? 'festivo' : r.worked === false ? 'cerrado' : 'abierto';
  const turno = (prefijo) => {
    const lineas = emptyShift();
    for (const [m, campo] of Object.entries(METODOS)) {
      lineas[m] = { cents: aCentimos(r[`${prefijo}_${campo}`]), customers: clientes(r[`${prefijo}_${campo}_customers`]) };
    }
    return lineas;
  };
  return {
    day: String(r.sale_date).slice(0, 10),
    status,
    extendedHours: Boolean(r.extended_schedule),
    manana: turno(TURNOS.manana),
    tarde: turno(TURNOS.tarde),
  };
}

export const huellaDia = (r) => {
  const d = diaDelAntiguo(r);
  return huella([d.day, d.status, d.extendedHours, d.manana, d.tarde]);
};

const linea = (l) => (l.cents || l.customers ? `${formatEuros(l.cents)} · ${l.customers} clientes` : '—');

/** Lo que cambia entre el día del antiguo y el del nuevo, campo a campo. */
export function diferenciasDia(antiguo, nuevo) {
  const difs = [];
  if (antiguo.status !== nuevo.status) difs.push({ campo: 'Día', antiguo: antiguo.status, nuevo: nuevo.status });
  for (const t of Object.keys(TURNOS)) {
    for (const m of Object.keys(METODOS)) {
      const a = antiguo[t][m];
      const n = nuevo[t][m];
      if (a.cents === n.cents && a.customers === n.customers) continue;
      difs.push({ campo: `${t === 'manana' ? 'Mañana' : 'Tarde'} · ${ETIQUETA_METODO[m]}`, antiguo: linea(a), nuevo: linea(n) });
    }
  }
  return difs;
}

export async function escribirDia(db, r, userId) {
  const d = diaDelAntiguo(r);
  await writeDay(db, d.day, { status: d.status, manana: d.manana, tarde: d.tarde, extendedHours: d.extendedHours, legacyId: r.id }, userId);
}

/* ---------- Gastos diarios ---------- */

export const conceptoDe = (g) => String(g.concept ?? '').trim().replace(/\s+/g, ' ');

export const gastoDelAntiguo = (g) => ({
  name: conceptoDe(g).slice(0, MAX_NOMBRE) || 'Gasto diario',
  date: String(g.sale_date).slice(0, 10),
  amountCents: aCentimos(g.amount),
});

export const huellaGasto = (g) => huella(gastoDelAntiguo(g));

/** El gasto tal como está en el nuevo (nombre, fecha e importe de su mes). */
export async function gastoActual(db, expenseId) {
  return (await db.query(
    `SELECT e.id, e.name, e.kind, e.category, to_char(e.expense_date, 'YYYY-MM-DD') AS date,
            to_char(e.start_month, 'YYYY-MM-DD') AS month,
            COALESCE(en.amount_cents, (SELECT a.amount_cents FROM recurring_amounts a
                WHERE a.expense_id = e.id AND a.from_month <= e.start_month ORDER BY a.from_month DESC LIMIT 1), 0) AS amount_cents
       FROM recurring_expenses e
       LEFT JOIN recurring_entries en ON en.expense_id = e.id AND en.month = e.start_month
      WHERE e.id = $1`,
    [expenseId],
  )).rows[0] ?? null;
}

export function diferenciasGasto(antiguo, actual, { conFecha = true } = {}) {
  const difs = [];
  if (antiguo.name !== actual.name) difs.push({ campo: 'Concepto', antiguo: antiguo.name, nuevo: actual.name });
  if (conFecha && antiguo.date !== actual.date) difs.push({ campo: 'Fecha', antiguo: fechaEs(antiguo.date), nuevo: fechaEs(actual.date) });
  if (antiguo.amountCents !== actual.amount_cents) difs.push({ campo: 'Importe', antiguo: formatEuros(antiguo.amountCents), nuevo: formatEuros(actual.amount_cents) });
  return difs;
}

async function marcarPagado(db, expenseId, month) {
  const entryId = await ensureEntry(db, expenseId, month);
  await db.query("UPDATE recurring_entries SET status = 'pagado', paid_at = COALESCE(paid_at, NOW()) WHERE id = $1", [entryId]);
}

/** Alta del gasto diario como esporádico, ya pagado (salió de la caja). */
export async function crearGasto(db, g, userId) {
  const x = gastoDelAntiguo(g);
  const id = await createExpense(db, { name: x.name, category: 'esporadico', kind: 'unico', amountCents: x.amountCents, date: x.date, userId });
  await db.query('UPDATE recurring_expenses SET legacy_ref = $2 WHERE id = $1', [id, `gestiondegastos:${g.id}`]);
  await marcarPagado(db, id, `${x.date.slice(0, 7)}-01`);
  return id;
}

/** Pone en el nuevo el concepto, la fecha y el importe del antiguo. */
export async function actualizarGasto(db, expenseId, { name, date, amountCents }) {
  const month = `${date.slice(0, 7)}-01`;
  const antes = await gastoActual(db, expenseId);
  await db.query('UPDATE recurring_expenses SET name = $2 WHERE id = $1', [expenseId, name]);
  if (date !== antes.date) {
    // Pago único: su mes es el de la fecha (con su importe, estado y documentos).
    await db.query(
      'UPDATE recurring_expenses SET expense_date = $2, start_month = $3, end_month = $3 WHERE id = $1',
      [expenseId, date, month],
    );
    await db.query('UPDATE recurring_entries SET month = $2 WHERE expense_id = $1', [expenseId, month]);
  }
  const entryId = await ensureEntry(db, expenseId, month);
  await db.query('UPDATE recurring_entries SET amount_cents = $2 WHERE id = $1', [entryId, amountCents]);
}

/** Pone en el nuevo el concepto y el importe del mensual del antiguo. */
export async function actualizarMensual(db, expenseId, { name, month, amountCents }) {
  await db.query('UPDATE recurring_expenses SET name = $2 WHERE id = $1', [expenseId, name]);
  const entryId = await ensureEntry(db, expenseId, month);
  await db.query('UPDATE recurring_entries SET amount_cents = $2 WHERE id = $1', [entryId, amountCents]);
}

/* ---------- Gastos mensuales ---------- */

const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** «Luz» + «Endesa» → «Luz · Endesa»; si el detalle repite la categoría, una vez. */
export function nombreMensual(m) {
  const cat = String(m.category ?? '').trim();
  const det = String(m.name ?? '').trim();
  const nombre = !det ? cat : !cat || normal(det).includes(normal(cat)) ? det : `${cat} · ${det}`;
  return (nombre || 'Gasto mensual').replace(/\s+/g, ' ').slice(0, MAX_NOMBRE);
}

export const mesDe = (m) => (/^\d{4}-\d{2}/.test(String(m.month_key ?? '')) ? `${String(m.month_key).slice(0, 7)}-01` : null);

export const mensualDelAntiguo = (m) => ({ name: nombreMensual(m), month: mesDe(m), amountCents: aCentimos(m.amount) });

export const huellaMensual = (m) => huella(mensualDelAntiguo(m));

/** ¿Dos conceptos son el mismo gasto? Todas las palabras del más corto están en el otro. */
export function mismoConcepto(a, b) {
  const pa = normal(a).split(' ').filter(Boolean);
  const pb = normal(b).split(' ').filter(Boolean);
  if (!pa.length || !pb.length) return false;
  const [corto, largo] = pa.length <= pb.length ? [pa, new Set(pb)] : [pb, new Set(pa)];
  return corto.every((p) => largo.has(p));
}

/** Un gasto del nuevo, activo ese mes, que ya sea el mensual del antiguo (para respetarlo). */
export async function mensualExistente(db, m) {
  const month = mesDe(m);
  // Con el concepto completo («Luz · Endesa»): la categoría suelta casaría gastos distintos.
  // Lo ya traído del antiguo no cuenta: solo lo que se apuntó aquí.
  const nombre = nombreMensual(m);
  const rows = (await db.query(
    `SELECT id, name FROM recurring_expenses
      WHERE category <> 'proveedor' AND start_month <= $1 AND (end_month IS NULL OR end_month >= $1)
        AND (legacy_ref IS NULL OR legacy_ref NOT LIKE 'gestiondegastos%')
      ORDER BY id`,
    [month],
  )).rows;
  return rows.find((r) => mismoConcepto(nombre, r.name)) ?? null;
}

/** Alta del mensual: recurrente variable solo de ese mes, con su importe (pendiente de justificante). */
export async function crearMensual(db, m, userId) {
  const x = mensualDelAntiguo(m);
  const id = await createExpense(db, { name: x.name, category: 'recurrente', kind: 'variable', startMonth: x.month, userId });
  await db.query('UPDATE recurring_expenses SET end_month = start_month, legacy_ref = $2 WHERE id = $1', [id, `gestiondegastos-mensual:${m.id}`]);
  const entryId = await ensureEntry(db, id, x.month);
  await db.query('UPDATE recurring_entries SET amount_cents = $2 WHERE id = $1', [entryId, x.amountCents]);
  return id;
}

/* ---------- Texto para la pantalla ---------- */

export function describir(item) {
  const d = item.data ?? {};
  if (item.source === 'dia') {
    return { titulo: `Caja del ${fechaEs(d.sale_date)}`, detalle: `${formatEuros(aCentimos(d.total_sales))} · ${clientes(d.customers_total)} clientes` };
  }
  if (item.source === 'gasto') {
    return { titulo: conceptoDe(d) || 'Gasto diario', detalle: `${fechaEs(d.sale_date)} · ${formatEuros(aCentimos(d.amount))}` };
  }
  if (item.source === 'mensual') {
    const mes = mesDe(d);
    return { titulo: nombreMensual(d), detalle: `${mes ? mes.slice(5, 7) + '/' + mes.slice(0, 4) : '—'} · ${formatEuros(aCentimos(d.amount))}` };
  }
  return { titulo: d.original_filename || 'Archivo', detalle: `${fechaEs(d.sale_date)} · gasto del día` };
}
