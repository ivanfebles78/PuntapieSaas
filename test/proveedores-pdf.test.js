import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DocumentoPdf, anchoTexto, recortar } from '../src/proveedores/pdf/documento.js';
import { generarCalendarioPdf } from '../src/proveedores/pdf/calendario.js';

/** Lee un PDF generado y devuelve el texto de cada página. */
async function leer(buffer) {
  const tarea = getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
  const doc = await tarea.promise;
  const paginas = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const contenido = await page.getTextContent();
    paginas.push(contenido.items.map((it) => it.str).join(' '));
  }
  await tarea.destroy();
  return paginas;
}

const HOY = '2026-10-14';
const v = (fecha, importe_cent, extra = {}) => ({
  fecha, importe_cent, proveedor_nombre: 'LEJAN BRAND SL', numero: 'F2617098', ...extra,
});

describe('escritor de PDF', () => {
  test('genera un PDF legible con varias páginas, acentos y euros', async () => {
    const doc = new DocumentoPdf();
    doc.texto('Año ñandú: 1.234,56 €', 36, 36, { tam: 12, negrita: true });
    doc.rect(36, 60, 100, 20, { relleno: '#ece6db', borde: '#1c1a17' });
    doc.linea(36, 90, 200, 90);
    doc.nuevaPagina().texto('Segunda', 36, 36);
    const paginas = await leer(doc.construir());
    assert.equal(paginas.length, 2);
    assert.match(paginas[0], /Año ñandú: 1\.234,56 €/);
    assert.match(paginas[1], /Segunda/);
  });

  test('anchoTexto y recortar miden el texto para que quepa', () => {
    assert.ok(anchoTexto('MMMM', 10) > anchoTexto('iiii', 10));
    assert.equal(recortar('corto', 100, 8), 'corto');
    const largo = recortar('INTERNATIONAL SHOES GARVALIN S.L.', 40, 6);
    assert.ok(largo.endsWith('…') && anchoTexto(largo, 6) <= 40);
  });
});

describe('calendario en PDF', () => {
  test('una página por mes, con los días, proveedores e importes del periodo', async () => {
    const pdf = generarCalendarioPdf([
      v('2026-10-20', 184500),
      v('2026-11-06', 319710, { proveedor_nombre: 'JEMMA FOOTWEAR', numero: 'FAC26//2601554' }),
      v('2026-12-01', 127222, { proveedor_nombre: 'GARVALIN', numero: '2613709' }),
    ], { hoy: HOY, meses: 3, subtitulo: 'Puntapié' });
    const paginas = await leer(pdf);

    assert.ok(paginas.length >= 3, 'al menos una página por mes');
    const todo = paginas.join('\n');
    assert.match(todo, /Calendario de pagos/);
    assert.match(todo, /octubre 2026/i);
    assert.match(todo, /NOVIEMBRE 2026/i);
    assert.match(todo, /DICIEMBRE 2026/i);
    assert.match(todo, /Lun.*Mar.*Mié.*Jue.*Vie.*Sáb.*Dom/s, 'cabecera de la semana');
    assert.match(todo, /1\.845,00 €/);
    assert.match(todo, /JEMMA FOOTWEAR/);
    assert.match(todo, /FAC26\/\/2601554/);
    assert.match(todo, /Página 1 de/);
  });

  test('marca lo vencido, lo que vence pronto y lo ya pagado', async () => {
    const pdf = generarCalendarioPdf([
      v('2026-08-20', 157581, { proveedor_nombre: 'PABLOSKY', numero: '25/20733' }),  // vencido de un mes anterior
      v('2026-10-16', 50000),                                                          // vence en 2 días
      v('2026-10-05', 20000, { pagado: true, proveedor_nombre: 'CONDOR' }),            // ya pagada
    ], { hoy: HOY, meses: 3 });
    const todo = (await leer(pdf)).join('\n');

    assert.match(todo, /VENCIDO Y SIN PAGAR/);
    assert.match(todo, /PABLOSKY/);
    assert.match(todo, /Vencida hace 55 días/);
    assert.match(todo, /Vence en 2 días/);
    assert.match(todo, /Pagada/);
    assert.match(todo, /1\.575,81 €/);
  });

  test('con 9 meses cubre el periodo completo y sin datos no falla', async () => {
    const paginas = await leer(generarCalendarioPdf([], { hoy: HOY, meses: 9 }));
    const todo = paginas.join('\n');
    assert.match(todo, /9 meses/);
    assert.match(todo, /octubre 2026/i);
    assert.match(todo, /JUNIO 2027/i, 'el noveno mes cruza el año');
    assert.match(todo, /Sin pagos previstos/);
    assert.ok(paginas.length >= 9);
  });
});
