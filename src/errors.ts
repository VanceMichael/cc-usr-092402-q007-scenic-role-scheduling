/** 带 HTTP 状态码与结构化 body 的业务错误，由 app 中间件统一转换。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : "http_error");
  }
}

export function badRequest(message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, { error: "bad_request", message, ...extra });
}

export function notFound(entity: string, id: string): HttpError {
  return new HttpError(404, { error: "not_found", entity, id });
}

export function conflict(body: Record<string, unknown>): HttpError {
  return new HttpError(409, body);
}

export function unprocessable(body: Record<string, unknown>): HttpError {
  return new HttpError(422, body);
}

/** 乐观锁校验：期望版本与当前版本不一致时抛 409。 */
export function checkVersion(entity: string, id: string, current: number, expected: unknown): void {
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    throw badRequest("缺少 expectedVersion（整数）", { entity, id, currentVersion: current });
  }
  if (expected !== current) {
    throw conflict({ error: "version_conflict", entity, id, currentVersion: current, expectedVersion: expected });
  }
}
