// Facturas de gastos recurrentes que llegan por correo. Se reconocen por su
// contenido (emisor y concepto), nunca por el nombre del archivo:
//   - Alquiler: la casera manda 4 facturas parciales («ARRENDADOR… Alquiler 25%»);
//     se adjuntan al mes de su emisión sin tocar el importe (es fijo).
//   - Agua y luz: sus refacturas («Consumo Agua / Consumo Electricidad»); cuentan
//     en el mes en que llegan, que es cuando se pagan. Las facturas originales de
//     la compañía (Canaragua, Octopus, Endesa) que vienen con ellas no hacen falta.
//   - Movistar, alarma (Movistar Prosegur), Asociación Zona Centro y Atecresa:
//     domiciliadas, así que el mes queda pagado.
//   - Asesoría (Lafuente): se paga por transferencia, queda pendiente.
// Los justificantes de transferencia no se asocian solos: no dicen de qué mes son.

const MESES = Object.freeze(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']);

/** Reglas por gasto: cómo se reconoce, cómo se busca en Gastos y cómo se trata. */
export const GASTOS = Object.freeze({
  alquiler: { nombre: 'Alquiler', busca: /alquiler/i, domiciliado: false, importe: 'no' },
  agua: { nombre: 'Agua', busca: /^agua\b/i, domiciliado: false, importe: 'suma', mesDelCorreo: true },
  luz: { nombre: 'Luz', busca: /^luz\b/i, domiciliado: false, importe: 'suma', mesDelCorreo: true },
  movistar: { nombre: 'Movistar', busca: /movistar/i, noBusca: /alarma/i, domiciliado: true, importe: 'suma' },
  alarma: { nombre: 'Alarma', busca: /alarma/i, domiciliado: true, importe: 'fijo' },
  asociacion: { nombre: 'Asociación Zona Centro', busca: /asociaci|zona centro/i, domiciliado: true, importe: 'fijo' },
  atecresa: { nombre: 'Atecresa', busca: /atecresa/i, domiciliado: true, importe: 'fijo' },
  asesoria: { nombre: 'Asesoría', busca: /asesor/i, domiciliado: false, importe: 'suma' },
});

const mes = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const anio = (yy) => (yy.length === 2 ? `20${yy}` : yy);

/** Mes de emisión escrito en el documento, en cualquiera de los formatos que usan. */
export function mesDelTexto(texto) {
  const t = String(texto);
  const emision = t.match(/Fecha (?:de )?emisi[oó]n:?\s*(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/i);
  if (emision) return mes(anio(emision[3]), Number(emision[2]));
  const larga = t.match(/\b(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/i);
  const n = larga ? MESES.indexOf(larga[2].toLowerCase()) : -1;
  if (n >= 0) return mes(larga[3], n + 1);
  const corta = t.match(/\bFecha(?: de expedici[oó]n| factura)?:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  return corta ? mes(anio(corta[3]), Number(corta[2])) : null;
}

/**
 * Qué es un PDF de gasto. Devuelve null si no es un gasto conocido, o
 * { gasto, clase: 'factura' | 'original' | 'justificante' }.
 */
export function reconocerGasto(texto) {
  const t = String(texto ?? '').replace(/\s+/g, ' ');
  if (/Transferencia ordenada|Detalle del movimiento|CARTA DE CARGO POR TRANSFERENCIA/i.test(t)) return { gasto: null, clase: 'justificante' };
  if (/ARRENDADORA?:/.test(t) && /Alquiler/i.test(t)) return { gasto: 'alquiler', clase: 'factura' };
  if (/Consumo Agua/i.test(t)) return { gasto: 'agua', clase: 'factura' };
  if (/Consumo Electricidad/i.test(t)) return { gasto: 'luz', clase: 'factura' };
  if (/MOVISTAR PROSEGUR|N[ºo°] contrato: MPA/i.test(t)) return { gasto: 'alarma', clase: 'factura' };
  if (/miMovistar|Factura n[uú]m: FM/i.test(t)) return { gasto: 'movistar', clase: 'factura' };
  if (/Asociaci[oó]n de Empresarios de Santa Cruz de Tenerife - Zona Centro/i.test(t)) return { gasto: 'asociacion', clase: 'factura' };
  if (/ATECRE,? ?S\.?A\.?|atecresa\.com/i.test(t)) return { gasto: 'atecresa', clase: 'factura' };
  if (/LAFUENTE GESTOR/i.test(t)) return { gasto: 'asesoria', clase: 'factura' };
  // Facturas originales de agua y luz que la casera reenvía junto a su refactura.
  if (/DATOS DE SUMINISTRO|Factura de Electricidad|Endesa Energ|Octopus Energy/i.test(t)) return { gasto: null, clase: 'original' };
  return null;
}
