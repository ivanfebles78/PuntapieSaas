import JSZip from 'jszip';
import { HttpError } from '../http-error.js';
import { emptyShift, withTransaction, writeDay } from './daily-sales.js';
import { createExpense } from './expenses.js';
import { readDay } from './money.js';

// Importa la exportación de ventas de la app antigua (gestiondegastos):
// ventas_puntapie.json (o el ZIP que lo contiene). Cada día recuerda su id de
// origen: lo que ya está no se pisa ni se duplica.

const OLD_METHODS = Object.freeze(['efectivo', 'tarjeta', 'bizum', 'bonos']);
const MAX_JSON_BYTES = 20 * 1024 * 1024;
// Pagos a proveedores apuntados como gasto diario: ya cuentan en el gestor de
// pagos a proveedores, así que no se importan («Pago Proveedor - Lejan»,
// «Pago Factura Lejan…», «Pedido a Garvalin · venc. 1/3»…).
const SUPPLIER_PAYMENT = /^\s*(pago\b|pedido a\b)/i;
// «tarde/efectivo: 30 clientes para 58,42 € (probable error de tecleo, ¿3?)»
const TYPO = /^(manana|tarde)\/(efectivo|tarjeta|bizum|bonos): (\d+) clientes .*¿(\d+)\?/;

const toCents = (n) => Math.round(Number(n ?? 0) * 100);

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/** Lee el JSON (suelto o dentro del ZIP) y, si va en el ZIP, las incidencias. */
async function readExport(buffer) {
  const isZip = buffer.subarray(0, 2).toString('latin1') === 'PK';
  let json;
  let incidencias = '';
  if (isZip) {
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new HttpError(400, 'El archivo no es un ZIP válido.', 'INVALID_ZIP');
    }
    const entry = zip.file(/(^|\/)ventas_puntapie\.json$/)[0];
    if (!entry) throw new HttpError(400, 'El ZIP no trae ventas_puntapie.json.', 'INVALID_EXPORT');
    json = await entry.async('string');
    if (json.length > MAX_JSON_BYTES) throw new HttpError(413, 'ventas_puntapie.json es demasiado grande.', 'TOO_BIG');
    incidencias = await zip.file(/(^|\/)incidencias\.csv$/)[0]?.async('string') ?? '';
  } else {
    json = buffer.toString('utf8');
  }
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'ventas_puntapie.json no es un JSON válido.', 'INVALID_EXPORT');
  }
  if (!Array.isArray(data?.dias)) throw new HttpError(400, 'No es la exportación de ventas: falta «dias».', 'INVALID_EXPORT');
  return { data, incidencias };
}

/** Erratas de clientes señaladas en incidencias.csv: «día|turno|método» → clientes correctos. */
export function typoFixes(incidenciasCsv) {
  const fixes = new Map();
  for (const [fecha, texto] of parseCsv(incidenciasCsv).slice(1)) {
    const m = TYPO.exec(texto ?? '');
    if (m) fixes.set(`${fecha}|${m[1]}|${m[2]}`, { from: Number(m[3]), to: Number(m[4]) });
  }
  return fixes;
}

function shiftFrom(old, day, shift, fixes, applied) {
  const lines = emptyShift();
  for (const m of OLD_METHODS) {
    let customers = Number(old?.clientes?.[m] ?? 0);
    const fix = fixes.get(`${day}|${shift}|${m}`);
    if (fix && fix.from === customers) {
      applied.push(`${day.split('-').reverse().join('/')} ${shift === 'manana' ? 'mañana' : 'tarde'} ${m}: ${fix.from} → ${fix.to} clientes`);
      customers = fix.to;
    }
    lines[m] = { cents: toCents(old?.importes?.[m]), customers: Math.max(0, Math.trunc(customers)) };
  }
  return lines;
}

/**
 * Importa días y gastos diarios. Con `fixTypos`, corrige las erratas de
 * clientes de incidencias.csv. Devuelve qué se importó y qué se dejó fuera.
 */
export async function importSales(pool, buffer, { userId, fixTypos = true }) {
  const { data, incidencias } = await readExport(buffer);
  const fixes = fixTypos ? typoFixes(incidencias) : new Map();
  const result = { dias: 0, yaEstaban: 0, festivos: 0, erratas: [], totalCents: 0, clientes: 0, gastos: 0, gastosCents: 0, gastosOmitidos: [], gastosYaEstaban: 0 };

  await withTransaction(pool, async (client) => {
    for (const d of data.dias) {
      const day = readDay(d.fecha, `La fecha ${d.fecha}`);
      const exists = await client.query('SELECT 1 FROM sales_days WHERE day = $1 OR legacy_id = $2', [day, d.id_origen ?? -1]);
      if (exists.rowCount) {
        result.yaEstaban += 1;
        continue;
      }
      const status = d.festivo ? 'festivo' : d.trabajado === false ? 'cerrado' : 'abierto';
      const manana = shiftFrom(d.manana, day, 'manana', fixes, result.erratas);
      const tarde = shiftFrom(d.tarde, day, 'tarde', fixes, result.erratas);
      await writeDay(client, day, { status, manana, tarde, extendedHours: Boolean(d.horario_extendido), legacyId: d.id_origen ?? null }, userId);
      result.dias += 1;
      if (status !== 'abierto') result.festivos += 1;
      for (const s of [manana, tarde]) {
        for (const m of OLD_METHODS) {
          result.totalCents += s[m].cents;
          result.clientes += s[m].customers;
        }
      }
    }

    for (const g of Array.isArray(data.gastos) ? data.gastos : []) {
      const concepto = String(g.concepto ?? '').trim();
      const ref = `gestiondegastos:${g.id_origen ?? `${g.fecha}:${concepto}`}`;
      if (SUPPLIER_PAYMENT.test(concepto)) {
        result.gastosOmitidos.push(`${String(g.fecha).split('-').reverse().join('/')} · ${concepto} · ${Number(g.importe).toFixed(2).replace('.', ',')} €`);
        continue;
      }
      const exists = await client.query('SELECT 1 FROM recurring_expenses WHERE legacy_ref = $1', [ref]);
      if (exists.rowCount) {
        result.gastosYaEstaban += 1;
        continue;
      }
      const amountCents = toCents(g.importe);
      const id = await createExpense(client, {
        name: concepto.slice(0, 80) || 'Gasto diario', category: 'esporadico', kind: 'unico', amountCents, date: readDay(g.fecha), userId,
      });
      await client.query('UPDATE recurring_expenses SET legacy_ref = $2 WHERE id = $1', [id, ref]);
      result.gastos += 1;
      result.gastosCents += amountCents;
    }
  });

  result.esperadoCents = data.totales?.total != null ? toCents(data.totales.total) : null;
  result.cuadra = result.esperadoCents === null || result.yaEstaban > 0 ? null : result.esperadoCents === result.totalCents;
  return result;
}
