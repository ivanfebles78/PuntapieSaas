// Factura de un gasto recurrente llegada por correo: se adjunta al mes que
// toca, se ajusta el importe y, si va domiciliada, el mes queda pagado.
import { parseDocumento } from '../proveedores/parsers/index.js';
import { findActive, findExpenseItem, setAmount, setStatus } from '../services/expenses.js';
import { addFile } from '../services/expense-files.js';
import { GASTOS, mesDelTexto } from './gastos.js';

const revisar = (reason, extra = {}) => ({ state: 'revisar', reason, ...extra });

async function buscarGasto(db, regla) {
  const rows = (await db.query("SELECT id, name, kind FROM recurring_expenses WHERE category = 'recurrente' ORDER BY id")).rows;
  return rows.filter((r) => regla.busca.test(r.name) && !(regla.noBusca?.test(r.name)));
}

/**
 * Registra la factura de un gasto ya reconocido (`gasto` = clave de GASTOS).
 * `mesCorreo` = 'YYYY-MM' del correo; `inicio` = 'YYYY-MM' desde el que la tienda es nuestra.
 */
export async function registrarGasto(pool, { gasto, pdfText, data, filename, mesCorreo, inicio }) {
  const regla = GASTOS[gasto];
  const encontrados = await buscarGasto(pool, regla);
  if (encontrados.length !== 1) {
    return revisar(encontrados.length ? `Hay varios gastos que podrían ser «${regla.nombre}»` : `No hay un gasto recurrente «${regla.nombre}» en Gastos`);
  }
  const expense = encontrados[0];
  const leido = parseDocumento(pdfText);
  const mes = regla.mesDelCorreo ? mesCorreo : mesDelTexto(pdfText.text) ?? leido.fecha?.slice(0, 7) ?? mesCorreo;
  const month = `${mes}-01`;
  if (mes < inicio) return { state: 'ignorado', reason: `Es de ${mes}, antes de que la tienda fuera nuestra`, expense_id: expense.id, month };
  try {
    await findActive(pool, expense.id, month);
  } catch {
    return revisar(`«${expense.name}» no está activo en ${mes}`, { expense_id: expense.id, month });
  }
  const antes = await findExpenseItem(pool, expense.id, month);
  const repetido = await pool.query(
    `SELECT 1 FROM expense_files f JOIN recurring_entries en ON en.id = f.entry_id
      WHERE en.expense_id = $1 AND en.month = $2 AND f.size_bytes = $3 AND f.data = $4 LIMIT 1`,
    [expense.id, month, data.length, data],
  );
  if (repetido.rowCount) return { state: 'ignorado', reason: `Ya estaba adjunta en «${expense.name}» de ${mes}`, expense_id: expense.id, month };

  await addFile(pool, { expenseId: expense.id, month, kind: 'factura', filename, mime: 'application/pdf', data, userId: null });
  const total = leido.total_cent;
  const notas = [];
  if (total > 0 && regla.importe === 'suma') {
    // La primera factura del mes fija el importe; las siguientes (dos de agua en un mes) se suman.
    const nuevo = antes.invoices.length ? antes.amountCents + total : total;
    await setAmount(pool, { expenseId: expense.id, month, amountCents: nuevo, scope: 'mes' });
    notas.push(`importe ${(nuevo / 100).toFixed(2).replace('.', ',')} €`);
  } else if (total > 0 && regla.importe === 'fijo' && total !== antes.amountCents) {
    await setAmount(pool, { expenseId: expense.id, month, amountCents: total, scope: 'mes' });
    notas.push(`importe del mes ${(total / 100).toFixed(2).replace('.', ',')} €`);
  } else if (!(total > 0) && regla.importe !== 'no') {
    notas.push('no se ha leído el importe: revísalo');
  }
  if (regla.domiciliado) {
    await setStatus(pool, { expenseId: expense.id, month, status: 'pagado' });
    notas.push('pagado (domiciliado)');
  }
  return {
    state: 'creado',
    reason: [`Adjunta en «${expense.name}» de ${mes}`, ...notas].join(' · '),
    expense_id: expense.id,
    month,
    etiqueta: `${expense.name} · ${mes}`,
  };
}
