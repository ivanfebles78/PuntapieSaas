import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { listExpenses } from './expenses.js';
import { shiftLabel, shiftOfTime, WEEKDAY_NAMES } from './shop-hours.js';
import { weekday } from './stats.js';

// Exportaciones en ZIP: un Excel con todos los movimientos y, en Gastos,
// también las facturas y justificantes tal como se subieron.

const MAX_EXPORT_MONTHS = 240; // 20 años: «todo el historial»
const EURO_FORMAT = '#,##0.00 "€"';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1A16' } };
const CATEGORY_LABELS = Object.freeze({ recurrente: 'Recurrente', esporadico: 'Esporádico', proveedor: 'Pago a proveedor' });
const KIND_LABELS = Object.freeze({ fijo: 'Fijo', variable: 'Variable', unico: 'Pago único' });
const STATUS_LABELS = Object.freeze({ pendiente: 'Pendiente', pagado: 'Pagado' });
const METHOD_LABELS = Object.freeze({ efectivo: 'Efectivo', tarjeta: 'Tarjeta', bizum: 'Bizum', bonos: 'Bonos consumo', vales: 'Vales' });
const FILE_FOLDERS = Object.freeze({ factura: 'facturas', justificante: 'justificantes' });

const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const toDate = (iso) => new Date(`${iso}T00:00:00Z`);

/** Nombre seguro para una ruta dentro del ZIP (sin barras ni caracteres prohibidos en Windows). */
export function safeName(text, max = 60) {
  const clean = String(text ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (clean || 'archivo').slice(0, max);
}

/** Hoja con cabecera oscura, filtros y la primera fila fija. */
function addSheet(workbook, name, columns) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFCF6' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const col of columns) {
    if (col.euros) sheet.getColumn(col.key).numFmt = EURO_FORMAT;
    if (col.date) sheet.getColumn(col.key).numFmt = 'dd/mm/yyyy';
  }
  return sheet;
}

/** Enlace relativo dentro del ZIP: al descomprimir, abre el documento desde el Excel. */
function linkCell(paths) {
  if (!paths.length) return '';
  if (paths.length === 1) return { text: paths[0], hyperlink: paths[0] };
  return paths.join('\n');
}

/* ---------- Gastos ---------- */

async function expenseFiles(pool, from, to) {
  const result = await pool.query(
    `SELECT f.id, f.kind, f.filename, f.size_bytes, en.expense_id, to_char(en.month, 'YYYY-MM') AS month
       FROM expense_files f JOIN recurring_entries en ON en.id = f.entry_id
      WHERE en.month BETWEEN $1 AND $2
      ORDER BY en.month, f.kind, f.id`,
    [from, to],
  );
  return result.rows;
}

/** Ruta de cada documento en el ZIP: facturas/2026-10/Luz/123 - factura.pdf */
function filePath(file, expenseName) {
  return `${FILE_FOLDERS[file.kind]}/${file.month}/${safeName(expenseName)}/${file.id} - ${safeName(file.filename, 120)}`;
}

/**
 * Prepara la exportación de Gastos entre dos meses («AAAA-MM-01»): libro
 * Excel y lista de documentos (sin leerlos aún: se leen uno a uno al escribir el ZIP).
 */
export async function buildExpensesExport(pool, { from, to }) {
  const { items, totals } = await listExpenses(pool, from, to, { maxMonths: MAX_EXPORT_MONTHS });
  const files = await expenseFiles(pool, from, to);
  const names = new Map(items.map((i) => [i.id, i.name]));
  const pathsOf = (item, kind) => files
    .filter((f) => f.expense_id === item.id && f.month === item.month && f.kind === kind)
    .map((f) => filePath(f, item.name));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Puntapié · Gestión';
  workbook.created = new Date();

  const sheet = addSheet(workbook, 'Gastos', [
    { header: 'Mes', key: 'month', width: 10 },
    { header: 'Fecha', key: 'date', width: 12, date: true },
    { header: 'Concepto', key: 'name', width: 32 },
    { header: 'Tipo', key: 'category', width: 18 },
    { header: 'Forma', key: 'kind', width: 12 },
    { header: 'Importe', key: 'amount', width: 14, euros: true },
    { header: 'Estado', key: 'status', width: 12 },
    { header: 'Pagado el', key: 'paidAt', width: 12, date: true },
    { header: 'Facturas', key: 'invoices', width: 48 },
    { header: 'Justificantes', key: 'receipts', width: 48 },
  ]);
  for (const item of items) {
    const row = sheet.addRow({
      month: item.month,
      date: item.date ? toDate(item.date) : null,
      name: item.name,
      category: CATEGORY_LABELS[item.category],
      kind: KIND_LABELS[item.kind],
      amount: item.amountCents / 100,
      status: STATUS_LABELS[item.status],
      paidAt: item.paidAt ? new Date(item.paidAt) : null,
      invoices: linkCell(pathsOf(item, 'factura')),
      receipts: linkCell(pathsOf(item, 'justificante')),
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }

  const summary = addSheet(workbook, 'Resumen por mes', [
    { header: 'Mes', key: 'month', width: 10 },
    { header: 'Recurrentes', key: 'recurrente', width: 15, euros: true },
    { header: 'Esporádicos', key: 'esporadico', width: 15, euros: true },
    { header: 'Proveedores', key: 'proveedor', width: 15, euros: true },
    { header: 'Total', key: 'total', width: 15, euros: true },
    { header: 'Pendiente', key: 'pending', width: 15, euros: true },
  ]);
  const months = [...new Set(items.map((i) => i.month))];
  for (const month of months) {
    const list = items.filter((i) => i.month === month);
    const sum = (filter) => list.filter(filter).reduce((t, i) => t + i.amountCents, 0) / 100;
    summary.addRow({
      month,
      recurrente: sum((i) => i.category === 'recurrente'),
      esporadico: sum((i) => i.category === 'esporadico'),
      proveedor: sum((i) => i.category === 'proveedor'),
      total: sum(() => true),
      pending: sum((i) => i.status === 'pendiente'),
    });
  }
  const totalRow = summary.addRow({
    month: 'TOTAL',
    recurrente: totals.byCategory.recurrente / 100,
    esporadico: totals.byCategory.esporadico / 100,
    proveedor: totals.byCategory.proveedor / 100,
    total: totals.totalCents / 100,
    pending: totals.pendingCents / 100,
  });
  totalRow.font = { bold: true };

  return {
    workbook,
    files: files.map((f) => ({ id: f.id, path: filePath(f, names.get(f.expense_id) ?? `gasto ${f.expense_id}`) })),
    count: items.length,
  };
}

/* ---------- Ventas ---------- */

/**
 * Libro de ventas: cada ticket con su turno y quién estaba, el resumen por
 * día frente al objetivo y la comparativa por empleado.
 */
export function buildSalesWorkbook({ sales, staffing, team, targets, staff, simulated, from, to }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Puntapié · Gestión';
  workbook.created = new Date();
  const names = new Map(team.map((m) => [m.id, m.name]));

  const list = addSheet(workbook, 'Ventas', [
    { header: 'Fecha', key: 'date', width: 12, date: true },
    { header: 'Hora', key: 'time', width: 8 },
    { header: 'Día', key: 'weekday', width: 11 },
    { header: 'Turno', key: 'shift', width: 22 },
    { header: 'Importe', key: 'amount', width: 13, euros: true },
    { header: 'Método de pago', key: 'method', width: 16 },
    { header: 'En el turno', key: 'staff', width: 30 },
  ]);
  const byDay = new Map();
  for (const sale of sales) {
    const day = sale.at.slice(0, 10);
    const time = sale.at.slice(11, 16);
    const shift = shiftOfTime(time);
    list.addRow({
      date: toDate(day),
      time,
      weekday: WEEKDAY_NAMES[weekday(day)],
      shift: shiftLabel(shift),
      amount: sale.cents / 100,
      method: METHOD_LABELS[sale.method] ?? sale.method,
      staff: staffing(day, shift).map((id) => names.get(id)).filter(Boolean).join(', '),
    });
    const bucket = byDay.get(day) ?? { cents: 0, tickets: 0 };
    bucket.cents += sale.cents;
    bucket.tickets += 1;
    byDay.set(day, bucket);
  }

  const days = addSheet(workbook, 'Por día', [
    { header: 'Fecha', key: 'date', width: 12, date: true },
    { header: 'Día', key: 'weekday', width: 11 },
    { header: 'Ventas', key: 'amount', width: 14, euros: true },
    { header: 'Tickets', key: 'tickets', width: 9 },
    { header: 'Ticket medio', key: 'avg', width: 13, euros: true },
    { header: 'Objetivo', key: 'target', width: 13, euros: true },
    { header: '¿Cumplido?', key: 'met', width: 11 },
  ]);
  for (const [day, b] of byDay) {
    days.addRow({
      date: toDate(day),
      weekday: WEEKDAY_NAMES[weekday(day)],
      amount: b.cents / 100,
      tickets: b.tickets,
      avg: b.cents / b.tickets / 100,
      target: targets.dailyCents / 100,
      met: b.cents >= targets.dailyCents ? 'Sí' : 'No',
    });
  }

  const people = addSheet(workbook, 'Por empleado', [
    { header: 'Empleado', key: 'name', width: 22 },
    { header: 'Turnos', key: 'shifts', width: 9 },
    { header: 'Ventas en sus turnos', key: 'amount', width: 20, euros: true },
    { header: 'Media por turno', key: 'avg', width: 16, euros: true },
    { header: 'Media mañanas', key: 'am', width: 15, euros: true },
    { header: 'Media tardes', key: 'pm', width: 15, euros: true },
    { header: 'Frente a la tienda', key: 'index', width: 17 },
  ]);
  people.getColumn('index').numFmt = '0%';
  for (const r of staff.rows) {
    people.addRow({
      name: r.name,
      shifts: r.shifts,
      amount: r.cents / 100,
      avg: r.avgPerShiftCents / 100,
      am: r.byShift.manana.avgCents / 100,
      pm: r.byShift.tarde.avgCents / 100,
      index: r.index,
    });
  }

  const info = workbook.addWorksheet('Información');
  info.columns = [{ key: 'k', width: 26 }, { key: 'v', width: 70 }];
  info.addRows([
    { k: 'Periodo', v: `Del ${esDate(from)} al ${esDate(to)}` },
    { k: 'Datos', v: simulated ? 'SIMULADOS (de ejemplo, no son ventas reales)' : 'Ventas reales registradas' },
    { k: 'Objetivo diario', v: `${(targets.dailyCents / 100).toFixed(2).replace('.', ',')} €` },
    { k: 'Por empleado', v: 'Cada persona suma el total de los turnos en los que estaba; «frente a la tienda» compara con la media de la tienda en los mismos turnos (100 % = lo normal).' },
  ]);
  info.getColumn('k').font = { bold: true };
  return workbook;
}

/* ---------- ZIP ---------- */

/**
 * Escribe el ZIP en `output` (la respuesta HTTP). Los documentos se leen de
 * la base de datos de uno en uno para no cargar todos en memoria. Si archiver
 * falla o el cliente corta la descarga, se aborta y se lanza el error (nunca
 * queda una promesa rechazada sin atender ni una petición colgada).
 */
export async function writeZip(output, { workbook, workbookName, files = [], readFile, readme }) {
  const zip = archiver('zip', { zlib: { level: 6 } });
  let finished = false;
  const failed = new Promise((_, reject) => {
    zip.on('error', reject);
    output.on('close', () => { if (!finished) reject(new Error('La descarga se interrumpió.')); });
  });
  failed.catch(() => {});
  const done = new Promise((resolve) => output.on('finish', () => { finished = true; resolve(); }));
  // Cada entrada se espera hasta que archiver la ha procesado: así solo hay
  // un documento en memoria a la vez.
  const add = (data, name) => {
    const written = new Promise((resolve) => zip.once('entry', resolve));
    zip.append(data, { name });
    return Promise.race([written, failed]);
  };
  zip.pipe(output);
  try {
    await add(Buffer.from(await workbook.xlsx.writeBuffer()), workbookName);
    if (readme) await add(readme, 'LEEME.txt');
    for (const file of files) {
      await add(await Promise.race([readFile(file.id), failed]), file.path);
    }
    await Promise.race([zip.finalize(), failed]);
    await Promise.race([done, failed]);
  } catch (error) {
    zip.abort();
    throw error;
  }
}
