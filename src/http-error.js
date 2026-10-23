/** Error de negocio con su código HTTP, para que la ruta lo traduzca tal cual. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Middleware final de un router: responde los HttpError y deja pasar el resto. */
export function httpErrorHandler(error, _req, res, next) {
  if (!(error instanceof HttpError)) return next(error);
  return res.status(error.status).json({ ok: false, error: error.message, code: error.code });
}
