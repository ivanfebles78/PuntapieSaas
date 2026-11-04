/** Error de negocio con su código HTTP, para que la ruta lo traduzca tal cual. `data` va en la respuesta si se da. */
export class HttpError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** Middleware final de un router: responde los HttpError y deja pasar el resto. */
export function httpErrorHandler(error, _req, res, next) {
  if (!(error instanceof HttpError)) return next(error);
  return res.status(error.status).json({ ok: false, error: error.message, code: error.code, ...(error.data === undefined ? {} : { data: error.data }) });
}
