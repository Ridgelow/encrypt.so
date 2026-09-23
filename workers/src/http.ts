const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  readonly retryAfter?: number;
  readonly headers?: Record<string, string>;

  constructor(
    readonly status: number,
    message: string,
    options?: { retryAfter?: number },
  ) {
    super(message);
    this.name = "HttpError";
    if (options?.retryAfter != null) {
      this.retryAfter = options.retryAfter;
      this.headers = { "retry-after": String(options.retryAfter) };
    }
  }
}

export function errorResponse(err: HttpError): Response {
  const body =
    err.retryAfter != null ? { error: err.message, retryAfter: err.retryAfter } : { error: err.message };
  return json(body, err.status, err.headers);
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS,
      ...extra,
    },
  });
}

/** Opaque bytes. Callers must not pass plaintext file contents. */
export function octet(body: ArrayBuffer, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      ...CORS,
    },
  });
}

export function empty(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

const MAX_BODY = 64 * 1024;

export async function readJson(request: Request, maxBytes = MAX_BODY): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared != null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new HttpError(413, "body too large");
  }
  const text = await request.text();
  if (!text) throw new HttpError(400, "empty body");
  if (text.length > maxBytes) throw new HttpError(413, "body too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectPrivateFields(value: unknown): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (/private/i.test(key)) {
      throw new HttpError(400, "private keys are not accepted");
    }
  }
}
