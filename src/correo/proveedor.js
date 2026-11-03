// Factura o pedido de proveedor llegado por correo: se registra solo si su
// lector lo ha leído entero y cuadra; si no, queda para revisar a mano.
import { HttpError } from '../http-error.js';
import { parseDocumento } from '../proveedores/parsers/index.js';
import { buscarDuplicado, crearDocumento, guardarArchivo, withTransaction } from '../proveedores/repo.js';
import { proponerTipos } from '../stock/propuesta.js';
import { registrarEntrada } from '../stock/repo.js';

const revisar = (reason) => ({ state: 'revisar', reason });

/** Por qué no se puede registrar solo (o null si está completo y cuadra). */
export function faltaParaRegistrar(e) {
  if (e.parser === 'generico') return 'Proveedor sin lector propio: revisa los datos';
  if (!e.proveedor?.nombre) return 'No se ha leído el proveedor';
  if (!e.numero) return 'No se ha leído el número';
  if (!e.fecha) return 'No se ha leído la fecha';
  if (e.tipo !== 'factura') return null;
  if (!(e.total_cent > 0)) return 'No se ha leído el total';
  const suma = e.vencimientos.reduce((s, v) => s + v.importe_cent, 0);
  if (!e.vencimientos.length) return 'No se han leído los vencimientos';
  if (suma !== e.total_cent) return 'Los vencimientos no suman el total';
  return null;
}

const etiqueta = (doc) => `${doc.tipo === 'pedido' ? 'Pedido' : 'Factura'} ${doc.numero} · ${doc.proveedor.nombre}`;

async function crear(pool, extraido, archivo, lineas) {
  return withTransaction(pool, async (client) => {
    const fileId = await guardarArchivo(client, archivo);
    const doc = await crearDocumento(client, { ...extraido, total_cent: extraido.total_cent ?? 0 }, { fileId, hash: archivo.sha256 });
    const entrada = lineas ? await registrarEntrada(client, doc, lineas, lineas[0]?.marca ?? doc.proveedor.nombre) : null;
    return { doc, entrada };
  });
}

/**
 * Registra un PDF de proveedor. `pdfText` es el texto ya extraído.
 * Devuelve { state, reason, doc_id?, etiqueta? } para mail_attachments.
 */
export async function registrarProveedor(pool, { pdfText, data, filename, sha256 }) {
  if (/TRANSS?ARRIO/i.test(pdfText.text)) return revisar('Factura de transporte (Transarrio): va en Gastos');
  const extraido = parseDocumento(pdfText);
  if (extraido.parser === 'generico') return { ...revisar('Proveedor sin lector propio: revisa los datos'), desconocido: true };
  const falta = faltaParaRegistrar(extraido);
  if (falta) return revisar(falta);

  const dup = await buscarDuplicado(pool, {
    hash: sha256, cif: extraido.proveedor.cif, nombre: extraido.proveedor.nombre, tipo: extraido.tipo,
    numero: extraido.numero, fecha: extraido.fecha, total_cent: extraido.total_cent,
  });
  if (dup) return { state: 'ignorado', reason: `Ya estaba registrado: ${dup.tipo} ${dup.numero} de ${dup.proveedor}`, doc_id: dup.id };

  const archivo = { data, filename, mime: 'application/pdf', sha256 };
  const lineas = extraido.lineas ?? [];
  // Tallas sin desglose («22-27: 6 pares»): la factura se crea, los productos se reparten a mano.
  if (!lineas.length || lineas.some((l) => l.tramo)) {
    const { doc } = await crear(pool, extraido, archivo, null);
    return lineas.length
      ? { state: 'productos', reason: 'Reparte los pares por tallas y da de alta los productos', doc_id: doc.id, etiqueta: etiqueta(doc) }
      : { state: 'creado', reason: 'Sin productos en el PDF', doc_id: doc.id, etiqueta: etiqueta(doc) };
  }
  const propuestas = await proponerTipos(pool, lineas, { parser: extraido.parser });
  try {
    const { doc, entrada } = await crear(pool, extraido, archivo, propuestas);
    const uds = entrada?.unidades ?? 0;
    return {
      state: 'creado',
      reason: entrada?.omitido ? `Productos ya dados de alta con ${entrada.omitido.tipo} ${entrada.omitido.numero}` : `${uds} unidades pendientes de recibir`,
      doc_id: doc.id, etiqueta: etiqueta(doc), unidades: uds,
    };
  } catch (error) {
    // Un producto que no encaja (talla, color…) no impide registrar la factura.
    if (!(error instanceof HttpError) || error.status !== 400) throw error;
    const { doc } = await crear(pool, extraido, archivo, null);
    return { state: 'productos', reason: `Productos por revisar: ${error.message}`, doc_id: doc.id, etiqueta: etiqueta(doc) };
  }
}
