// Extracción con Claude para proveedores sin parser propio (opcional).
// Solo se usa si hay ANTHROPIC_API_KEY. Se llama a la API REST directamente
// para no añadir dependencias; la respuesta se fuerza a JSON mediante tool use.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_CHARS = 60_000;

const TOOL = {
  name: 'registrar_documento',
  description: 'Registra los datos extraídos de una factura o pedido de proveedor.',
  input_schema: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['factura', 'pedido'] },
      proveedor_nombre: { type: ['string', 'null'], description: 'Razón social del proveedor (quien emite el documento), no del cliente.' },
      proveedor_cif: { type: ['string', 'null'], description: 'CIF/NIF del proveedor sin prefijo ES.' },
      numero: { type: ['string', 'null'], description: 'Número del documento tal como aparece.' },
      fecha: { type: ['string', 'null'], description: 'Fecha de emisión en formato YYYY-MM-DD.' },
      total: { type: ['number', 'null'], description: 'Importe total a pagar en euros (con decimales).' },
      vencimientos: {
        type: 'array',
        description: 'Fechas de vencimiento con su importe en euros. Vacío para pedidos.',
        items: { type: 'object', properties: { fecha: { type: 'string' }, importe: { type: 'number' } }, required: ['fecha', 'importe'] },
      },
      pedidos: { type: 'array', items: { type: 'string' }, description: 'Números de pedido citados.' },
      albaranes: { type: 'array', items: { type: 'string' }, description: 'Números de albarán citados.' },
      fecha_entrega: { type: ['string', 'null'], description: 'Fecha de entrega de la mercancía, YYYY-MM-DD.' },
      forma_pago: { type: ['string', 'null'] },
    },
    required: ['tipo', 'proveedor_nombre', 'proveedor_cif', 'numero', 'fecha', 'total', 'vencimientos', 'pedidos', 'albaranes', 'fecha_entrega', 'forma_pago'],
  },
};

/**
 * @param {string} texto texto del PDF
 * @param {{ apiKey: string, model: string, cifsPropios: string[], fetchImpl?: typeof fetch }} opts
 * @returns {Promise<import('../parsers/index.js').Extraido>}
 */
export async function extraerConIA(texto, { apiKey, model, cifsPropios = [], fetchImpl = fetch }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');
  const prompt = `Eres un contable. Extrae los datos de este documento de un proveedor de calzado.
La empresa cliente (receptora) tiene CIF ${cifsPropios.join(', ') || 'desconocido'}: NO es el proveedor.
Los pedidos no tienen vencimientos; las facturas sí (si no aparece ninguno, usa la fecha de la factura por el total).
Si hay varios vencimientos, cada uno con su importe. Fechas en YYYY-MM-DD. Importes en euros como número.

TEXTO DEL DOCUMENTO:
${texto.slice(0, MAX_CHARS)}`;

  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const cuerpo = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${cuerpo.slice(0, 300)}`);
  }
  const data = await res.json();
  const uso = data.content?.find((c) => c.type === 'tool_use');
  if (!uso) throw new Error('Claude no devolvió datos estructurados');
  return normalizar(uso.input);
}

const RE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (s) => (typeof s === 'string' && RE_ISO.test(s) ? s : null);
const cent = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null);

function normalizar(x) {
  const vencimientos = (Array.isArray(x.vencimientos) ? x.vencimientos : [])
    .map((v) => ({ fecha: iso(v.fecha), importe_cent: cent(v.importe) }))
    .filter((v) => v.fecha && v.importe_cent != null);
  return {
    tipo: x.tipo === 'pedido' ? 'pedido' : 'factura',
    proveedor: { nombre: x.proveedor_nombre || null, cif: x.proveedor_cif ? String(x.proveedor_cif).toUpperCase().replace(/^ES/, '') : null },
    numero: x.numero ? String(x.numero) : null,
    fecha: iso(x.fecha),
    total_cent: cent(x.total),
    vencimientos: x.tipo === 'pedido' ? [] : vencimientos,
    pedidos: (Array.isArray(x.pedidos) ? x.pedidos : []).map(String),
    albaranes: (Array.isArray(x.albaranes) ? x.albaranes : []).map(String),
    fecha_entrega: iso(x.fecha_entrega),
    forma_pago: x.forma_pago || null,
    parser: 'ia',
    confianza: 'media',
    avisos: ['Datos extraídos con IA: revísalos antes de guardar.'],
  };
}
