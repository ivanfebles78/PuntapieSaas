// Dibuja el calendario de pagos en PDF: una página por mes con la rejilla de días
// y, debajo, el detalle de cada día (proveedor, factura e importe).
import { DocumentoPdf, A4, anchoTexto, recortar } from './documento.js';
import { construirCalendario, DIAS_SEMANA } from '../domain/calendario.js';

const MARGEN = 36;
const ANCHO_UTIL = A4.ancho - MARGEN * 2;
const PIE = A4.alto - 28;

const COLOR = {
  tinta: '#1c1a17',
  suave: '#6b655c',
  linea: '#d9d2c4',
  papel: '#f5f1ea',
  cabecera: '#ece6db',
  vencido: '#5b2a86',   // morado: vencido y sin pagar
  urgente: '#a93a2f',   // rojo: vence en los próximos 7 días
  pagado: '#1f5f52',
  finde: '#f0ece3',
};

/** 184500 -> "1.845,00 €". Formateo propio: no depende de los locales (ICU) del servidor. */
export function eur(cent) {
  const negativo = cent < 0;
  const abs = Math.abs(Math.round(cent));
  const entero = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativo ? '-' : ''}${entero},${String(abs % 100).padStart(2, '0')} €`;
}
const fechaCorta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fechaLarga = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const diasEntre = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * @param {{ fecha: string, importe_cent: number, pagado?: boolean, proveedor_nombre: string, numero: string }[]} vencimientos
 * @param {{ hoy: string, meses: number, titulo?: string, subtitulo?: string }} opts
 * @returns {Buffer}
 */
export function generarCalendarioPdf(vencimientos, { hoy, meses, titulo = 'Calendario de pagos', subtitulo = '' }) {
  const datos = construirCalendario(vencimientos, { hoy, meses });
  const doc = new DocumentoPdf();
  let y = portada(doc, datos, { titulo, subtitulo });

  datos.calendario.forEach((mes, i) => {
    // El primer mes continúa en la portada si queda sitio; el resto, página nueva.
    if (i > 0 || y + alturaRejilla(mes) + 90 > PIE) { doc.nuevaPagina(); y = MARGEN; }
    y = dibujarMes(doc, mes, datos.hoy, y);
  });

  if (datos.posteriores.items.length) {
    if (y + 60 > PIE) { doc.nuevaPagina(); y = MARGEN; }
    doc.texto(`Después de ${datos.calendario.at(-1).etiqueta}: ${eur(datos.posteriores.total_cent)} en `
      + `${datos.posteriores.items.length} vencimiento(s) más`, MARGEN, y + 8, { tam: 9, color: COLOR.suave });
  }

  pies(doc, datos);
  return doc.construir();
}

function portada(doc, datos, { titulo, subtitulo }) {
  let y = MARGEN;
  doc.rect(MARGEN, y, ANCHO_UTIL, 54, { relleno: COLOR.cabecera });
  doc.texto(titulo, MARGEN + 12, y + 10, { tam: 18, negrita: true, color: COLOR.tinta });
  const periodo = `${datos.calendario[0].etiqueta} – ${datos.calendario.at(-1).etiqueta} (${datos.meses} meses)`;
  doc.texto(subtitulo ? `${subtitulo} · ${periodo}` : periodo, MARGEN + 12, y + 33, { tam: 10, color: COLOR.suave });
  doc.texto(`Generado el ${fechaLarga(datos.hoy)}`, MARGEN, y + 33, { tam: 9, color: COLOR.suave, alinear: 'derecha', ancho: ANCHO_UTIL - 12 });
  y += 54 + 16;

  // Tres cifras de cabecera.
  const cajas = [
    ['Pendiente en el periodo', eur(datos.total_pendiente_cent), COLOR.tinta],
    ['Vencido y sin pagar', eur(datos.vencidos.total_cent), datos.vencidos.total_cent ? COLOR.vencido : COLOR.suave],
    ['Después del periodo', eur(datos.posteriores.total_cent), COLOR.suave],
  ];
  const anchoCaja = (ANCHO_UTIL - 16) / 3;
  cajas.forEach(([etiqueta, valor, color], i) => {
    const x = MARGEN + i * (anchoCaja + 8);
    doc.rect(x, y, anchoCaja, 44, { relleno: COLOR.papel, borde: COLOR.linea });
    doc.texto(etiqueta.toUpperCase(), x + 8, y + 8, { tam: 7, color: COLOR.suave });
    doc.texto(valor, x + 8, y + 20, { tam: 14, negrita: true, color });
  });
  y += 44 + 18;

  if (datos.vencidos.items.length) {
    doc.texto('VENCIDO Y SIN PAGAR', MARGEN, y, { tam: 8, negrita: true, color: COLOR.vencido });
    y += 14;
    y = tablaDetalle(doc, datos.vencidos.items, y, datos.hoy, { mostrarAnio: true });
    y += 12;
  }
  return y;
}

const ALTO_CELDA = 64;
const alturaRejilla = (mes) => 16 + mes.semanas.length * ALTO_CELDA;

function dibujarMes(doc, mes, hoy, yInicio) {
  let y = yInicio;
  doc.texto(mes.etiqueta.toUpperCase(), MARGEN, y, { tam: 13, negrita: true, color: COLOR.tinta });
  const resumen = mes.total_cent
    ? `${eur(mes.total_cent)} por pagar en ${mes.dias_con_pagos} día(s)`
    : 'Sin pagos previstos';
  doc.texto(resumen, MARGEN, y + 2, { tam: 9, color: mes.total_cent ? COLOR.tinta : COLOR.suave, alinear: 'derecha', ancho: ANCHO_UTIL });
  y += 18;

  const anchoCol = ANCHO_UTIL / 7;
  doc.rect(MARGEN, y, ANCHO_UTIL, 16, { relleno: COLOR.cabecera });
  DIAS_SEMANA.forEach((d, i) => {
    doc.texto(d, MARGEN + i * anchoCol, y + 4, { tam: 8, negrita: true, color: COLOR.suave, alinear: 'centro', ancho: anchoCol });
  });
  y += 16;

  for (const semana of mes.semanas) {
    semana.forEach((celda, i) => dibujarCelda(doc, celda, MARGEN + i * anchoCol, y, anchoCol, i >= 5, hoy));
    y += ALTO_CELDA;
  }
  doc.rect(MARGEN, y - mes.semanas.length * ALTO_CELDA - 16, ANCHO_UTIL, mes.semanas.length * ALTO_CELDA + 16, { borde: COLOR.linea });
  y += 14;

  const conPagos = mes.items.length ? mes.semanas.flat().filter((c) => c && c.items.length) : [];
  if (conPagos.length) {
    doc.texto('DETALLE', MARGEN, y, { tam: 8, negrita: true, color: COLOR.suave });
    y += 12;
    y = tablaDetalle(doc, conPagos.flatMap((c) => c.items), y, hoy);
  }
  return y;
}

function dibujarCelda(doc, celda, x, y, ancho, esFinde, hoy) {
  doc.rect(x, y, ancho, ALTO_CELDA, { borde: COLOR.linea, relleno: celda && esFinde ? COLOR.finde : null });
  if (!celda) return;

  const resaltar = celda.items.some((v) => !v.pagado);
  if (celda.esHoy) doc.rect(x, y, ancho, 2.5, { relleno: COLOR.tinta });
  doc.texto(String(celda.dia), x + 4, y + 4, {
    tam: 8.5, negrita: resaltar || celda.esHoy, color: celda.pasado && !resaltar ? COLOR.suave : COLOR.tinta,
  });
  if (celda.total_cent) {
    doc.texto(eur(celda.total_cent), x + 2, y + 4, { tam: 7, negrita: true, color: colorVto(celda.items.find((v) => !v.pagado), hoy), alinear: 'derecha', ancho: ancho - 6 });
  }

  const MAX_LINEAS = 4;
  const visibles = celda.items.slice(0, celda.items.length > MAX_LINEAS ? MAX_LINEAS - 1 : MAX_LINEAS);
  // Con un único vencimiento el importe ya está arriba: en la línea solo va el proveedor.
  const soloProveedor = celda.items.length === 1 && !celda.items[0].pagado;
  let ty = y + 16;
  for (const v of visibles) {
    const color = v.pagado ? COLOR.pagado : colorVto(v, hoy);
    if (soloProveedor) {
      doc.texto(recortar(v.proveedor_nombre, ancho - 8, 6), x + 4, ty, { tam: 6, color });
    } else {
      const importe = eur(v.importe_cent);
      doc.texto(recortar(v.proveedor_nombre, ancho - 12 - anchoTexto(importe, 6), 6), x + 4, ty, { tam: 6, color });
      doc.texto(importe, x + 2, ty, { tam: 6, color, alinear: 'derecha', ancho: ancho - 6 });
    }
    ty += 8.5;
  }
  if (celda.items.length > MAX_LINEAS) {
    doc.texto(`+${celda.items.length - (MAX_LINEAS - 1)} más`, x + 4, ty, { tam: 6, color: COLOR.suave });
  }
}

/** Morado si ya venció, rojo si vence en 7 días, tinta normal en el resto. */
function colorVto(v, hoy) {
  if (!v) return COLOR.tinta;
  if (v.pagado) return COLOR.pagado;
  const dias = diasEntre(v.fecha, hoy);
  if (dias < 0) return COLOR.vencido;
  return dias <= 7 ? COLOR.urgente : COLOR.tinta;
}

/** Tabla: fecha | proveedor | factura | estado | importe. Devuelve la y final. */
function tablaDetalle(doc, items, yInicio, hoy, { mostrarAnio = false } = {}) {
  const ALTO = 13;
  const col = { fecha: MARGEN, proveedor: MARGEN + 52, numero: MARGEN + 250, estado: MARGEN + 370 };
  let y = yInicio;
  let ultimaFecha = null;

  for (const v of items) {
    if (y + ALTO > PIE - 10) {
      doc.nuevaPagina();
      y = MARGEN;
      doc.texto('(continuación)', MARGEN, y, { tam: 8, color: COLOR.suave });
      y += 14;
      ultimaFecha = null;
    }
    const color = v.pagado ? COLOR.pagado : colorVto(v, hoy);
    if (v.fecha !== ultimaFecha) {
      doc.texto(mostrarAnio ? fechaLarga(v.fecha) : fechaCorta(v.fecha), col.fecha, y, { tam: 8, negrita: true, color });
      ultimaFecha = v.fecha;
    }
    doc.texto(recortar(v.proveedor_nombre, col.numero - col.proveedor - 8, 8), col.proveedor, y, { tam: 8, color: COLOR.tinta });
    doc.texto(recortar(v.numero ?? '', col.estado - col.numero - 8, 8), col.numero, y, { tam: 8, color: COLOR.suave });
    doc.texto(etiquetaEstado(v, hoy), col.estado, y, { tam: 7.5, color });
    doc.texto(eur(v.importe_cent), MARGEN, y, { tam: 8, negrita: !v.pagado, color, alinear: 'derecha', ancho: ANCHO_UTIL });
    y += ALTO;
    doc.linea(MARGEN, y - 3, MARGEN + ANCHO_UTIL, y - 3, { color: COLOR.linea, grosor: 0.3 });
  }
  return y;
}

function etiquetaEstado(v, hoy) {
  if (v.pagado) return 'Pagada';
  const dias = diasEntre(v.fecha, hoy);
  if (dias < 0) return dias === -1 ? 'Vencida ayer' : `Vencida hace ${-dias} días`;
  if (dias === 0) return 'Vence hoy';
  if (dias === 1) return 'Vence mañana';
  return `Vence en ${dias} días`;
}

function pies(doc, datos) {
  doc.enCadaPagina((n, total) => {
    doc.linea(MARGEN, PIE - 6, MARGEN + ANCHO_UTIL, PIE - 6, { color: COLOR.linea, grosor: 0.4 });
    doc.texto('Morado: vencido · Rojo: vence en 7 días · Verde: ya pagado', MARGEN, PIE, { tam: 7, color: COLOR.suave });
    doc.texto(`Página ${n} de ${total}`, MARGEN, PIE, { tam: 7, color: COLOR.suave, alinear: 'derecha', ancho: ANCHO_UTIL });
  });
  return doc;
}
