/** Content-Disposition con nombre UTF-8 (RFC 5987) y alternativa ASCII; PDF e imágenes se abren en el navegador. */
export function contentDisposition(filename, mime, { download = false } = {}) {
  const viewable = mime === 'application/pdf' || mime.startsWith('image/');
  const disposition = viewable && !download ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Envía un documento guardado en la base de datos, en su pestaña y sin poder ejecutar nada. */
export function sendStoredFile(res, { filename, mime, data }, options) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', contentDisposition(filename, mime, options));
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(data);
}
