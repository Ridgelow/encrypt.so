import { HttpError, isRecord, rejectPrivateFields } from "./http";

const STUB_CODE = "000000";
const CHALLENGE_TTL_SECONDS = 60 * 10;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_STARTS = 8;
const MAX_ATTEMPTS = 5;

type Challenge = {
  phone: string;
  code: string;
  attempts: number;
};

type Session = {
  userId: string;
  createdAt: number;
};

export function normalizePhone(input: unknown): string {
  if (typeof input !== "string") throw new HttpError(400, "phone required");
  const digits = input.trim().replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) throw new HttpError(400, "invalid phone");
  return `+${digits}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bumpRateLimit(env: Env, phone: string): Promise<void> {
  const key = `ratelimit:start:${phone}`;
  const current = Number((await env.SESSIONS.get(key)) ?? "0");
  if (current >= MAX_STARTS) throw new HttpError(429, "slow down");
  await env.SESSIONS.put(key, String(current + 1), { expirationTtl: CHALLENGE_TTL_SECONDS });
}

/**
 * POST /auth/phone/start
 * { phone } → { challengeId }
 * Stub SMS: the code is always 000000, stored in KV until it expires.
 */
export async function startPhone(env: Env, body: unknown): Promise<{ challengeId: string }> {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  const phone = normalizePhone(body.phone);
  await bumpRateLimit(env, phone);

  const challengeId = crypto.randomUUID();
  const challenge: Challenge = { phone, code: STUB_CODE, attempts: 0 };
  await env.SESSIONS.put(`challenge:${challengeId}`, JSON.stringify(challenge), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
  console.log(`sms stub challenge=${challengeId} code=${STUB_CODE}`);
  return { challengeId };
}

async function findOrCreateUser(env: Env, phone: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE phone = ?")
    .bind(phone)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  try {
    await env.DB.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)")
      .bind(id, phone, createdAt)
      .run();
    return id;
  } catch {
    const raced = await env.DB.prepare("SELECT id FROM users WHERE phone = ?")
      .bind(phone)
      .first<{ id: string }>();
    if (raced) return raced.id;
    throw new HttpError(500, "could not create user");
  }
}

/**
 * POST /auth/phone/verify
 * { challengeId, code } → { sessionToken, userId }
 */
export async function verifyPhone(
  env: Env,
  body: unknown,
): Promise<{ sessionToken: string; userId: string }> {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  const challengeId = body.challengeId;
  const code = body.code;
  if (typeof challengeId !== "string" || challengeId.length < 8) {
    throw new HttpError(400, "challengeId required");
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new HttpError(400, "code required");
  }

  const key = `challenge:${challengeId}`;
  const raw = await env.SESSIONS.get(key);
  if (!raw) throw new HttpError(401, "code rejected");

  let challenge: Challenge;
  try {
    challenge = JSON.parse(raw) as Challenge;
  } catch {
    await env.SESSIONS.delete(key);
    throw new HttpError(401, "code rejected");
  }

  if (challenge.code !== code) {
    const attempts = challenge.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await env.SESSIONS.delete(key);
    } else {
      await env.SESSIONS.put(key, JSON.stringify({ ...challenge, attempts }), {
        expirationTtl: CHALLENGE_TTL_SECONDS,
      });
    }
    throw new HttpError(401, "code rejected");
  }

  await env.SESSIONS.delete(key);
  const userId = await findOrCreateUser(env, challenge.phone);
  const sessionToken = randomToken();
  const session: Session = { userId, createdAt: Date.now() };
  await env.SESSIONS.put(`session:${sessionToken}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return { sessionToken, userId };
}

export async function requireUser(request: Request, env: Env): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, "missing session");
  const raw = await env.SESSIONS.get(`session:${match[1]}`);
  if (!raw) throw new HttpError(401, "invalid session");
  try {
    const session = JSON.parse(raw) as Session;
    if (!session.userId) throw new Error("missing user");
    return session.userId;
  } catch {
    throw new HttpError(401, "invalid session");
  }
}
