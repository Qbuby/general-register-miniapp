export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new AppError(400, code, message, details);

/**
 * Used for both "does not exist" and "exists but belongs to another tenant".
 * We deliberately never distinguish the two, so that probing another
 * institution's identifiers cannot confirm whether they exist.
 */
export const notFound = (message = '资源不存在') => new AppError(404, 'not_found', message);

export const forbidden = (message = '没有操作权限') => new AppError(403, 'forbidden', message);

export const unauthorized = (message = '请先登录') => new AppError(401, 'unauthorized', message);

export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new AppError(409, code, message, details);

/**
 * 503 for capabilities that are genuinely unavailable in this deployment
 * (e.g. mini-program codes without WX_APPID/WX_APPSECRET). Never silently
 * substituted with a fake image — see docs/QR-CODES.md.
 */
export const serviceUnavailable = (message: string, details?: unknown) =>
  new AppError(503, 'service_unavailable', message, details);
