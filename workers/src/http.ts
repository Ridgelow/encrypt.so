const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS,
    },
  });
}

export function empty(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

const MAX_BODY = 64 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) throw new HttpError(400, "empty body");
  if (text.length > MAX_BODY) throw new HttpError(413, "body too large");
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
