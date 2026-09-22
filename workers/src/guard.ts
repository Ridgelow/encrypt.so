/**
 * Fixed-window counters, retention math, and connection admission.
 * KV writes are best-effort under concurrency: two requests can read the same
 * count and both increment. Windows do not store message bodies.
 */

export const DEFAULT_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_CIPHERTEXT_CHARS = 49152;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_WS_PER_CONVERSATION = 32;
export const DEFAULT_MAX_WS_PER_USER = 8;
export const DEFAULT_MAX_WS_PER_USER_GLOBAL = 16;
export const WS_REJECT_RETRY_AFTER_SEC = 30;

const IP_RE = /^[A-Za-z0-9:.]{1,64}$/;

export type GuardEnv = {
  MESSAGE_TTL_MS?: string;
  RATE_AUTH_START_PER_PHONE?: string;
  RATE_AUTH_START_PER_IP?: string;
  RATE_AUTH_START_WINDOW_SEC?: string;
  RATE_AUTH_VERIFY_PER_IP?: string;
  RATE_AUTH_VERIFY_WINDOW_SEC?: string;
  RATE_MESSAGE_PER_USER?: string;
  RATE_MESSAGE_PER_IP?: string;
  RATE_MESSAGE_WINDOW_SEC?: string;
  RATE_PUSH_PER_USER?: string;
  RATE_PUSH_PER_IP?: string;
  RATE_PUSH_WINDOW_SEC?: string;
  RATE_ATTACHMENT_PER_USER?: string;
  RATE_ATTACHMENT_PER_IP?: string;
  RATE_ATTACHMENT_WINDOW_SEC?: string;
  MAX_BODY_BYTES?: string;
  MAX_CIPHERTEXT_CHARS?: string;
  MAX_ATTACHMENT_BYTES?: string;
  MAX_WS_PER_CONVERSATION?: string;
  MAX_WS_PER_USER?: string;
  MAX_WS_PER_USER_GLOBAL?: string;
  AUTH_FAIL_BACKOFF_BASE_MS?: string;
  AUTH_FAIL_BACKOFF_MAX_MS?: string;
  BLOCKLIST_PHONES?: string;
  BLOCKLIST_IPS?: string;
};

export type GuardConfig = {
  messageTtlMs: number;
  authStartPerPhone: number;
  authStartPerIp: number;
  authStartWindowMs: number;
  authVerifyPerIp: number;
  authVerifyWindowMs: number;
  messagePerUser: number;
  messagePerIp: number;
  messageWindowMs: number;
  pushPerUser: number;
  pushPerIp: number;
  pushWindowMs: number;
  attachmentPerUser: number;
  attachmentPerIp: number;
  attachmentWindowMs: number;
  maxBodyBytes: number;
  maxCiphertextChars: number;
  maxAttachmentBytes: number;
  maxWsPerConversation: number;
  maxWsPerUser: number;
  maxWsPerUserGlobal: number;
  authFailBackoffBaseMs: number;
  authFailBackoffMaxMs: number;
  blocklistPhones: string[];
  blocklistIps: string[];
};

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export type Counter = { count: number; resetAt: number };

export type FailState = { fails: number; lockedUntil: number };

export type Admit =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; scope: "conversation" | "user" | "user_global" };

function intEnv(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) return fallback;
  return parsed;
}

export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Phone blocklist entries use the same +E.164 form as auth. Invalid entries are dropped. */
export function normalizeBlockPhone(value: string): string | null {
  const digits = value.trim().replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function loadGuardConfig(env: GuardEnv): GuardConfig {
  const phones: string[] = [];
  for (const entry of parseList(env.BLOCKLIST_PHONES)) {
    const phone = normalizeBlockPhone(entry);
    if (phone) phones.push(phone);
  }
  return {
    messageTtlMs: intEnv(env.MESSAGE_TTL_MS, DEFAULT_MESSAGE_TTL_MS),
    authStartPerPhone: intEnv(env.RATE_AUTH_START_PER_PHONE, 8),
    authStartPerIp: intEnv(env.RATE_AUTH_START_PER_IP, 30),
    authStartWindowMs: intEnv(env.RATE_AUTH_START_WINDOW_SEC, 600) * 1000,
    authVerifyPerIp: intEnv(env.RATE_AUTH_VERIFY_PER_IP, 40),
    authVerifyWindowMs: intEnv(env.RATE_AUTH_VERIFY_WINDOW_SEC, 600) * 1000,
    messagePerUser: intEnv(env.RATE_MESSAGE_PER_USER, 60),
    messagePerIp: intEnv(env.RATE_MESSAGE_PER_IP, 120),
    messageWindowMs: intEnv(env.RATE_MESSAGE_WINDOW_SEC, 60) * 1000,
    pushPerUser: intEnv(env.RATE_PUSH_PER_USER, 10),
    pushPerIp: intEnv(env.RATE_PUSH_PER_IP, 20),
    pushWindowMs: intEnv(env.RATE_PUSH_WINDOW_SEC, 60) * 1000,
    attachmentPerUser: intEnv(env.RATE_ATTACHMENT_PER_USER, 30),
    attachmentPerIp: intEnv(env.RATE_ATTACHMENT_PER_IP, 60),
    attachmentWindowMs: intEnv(env.RATE_ATTACHMENT_WINDOW_SEC, 60) * 1000,
    maxBodyBytes: intEnv(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    maxCiphertextChars: intEnv(env.MAX_CIPHERTEXT_CHARS, DEFAULT_MAX_CIPHERTEXT_CHARS),
    maxAttachmentBytes: intEnv(env.MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxWsPerConversation: intEnv(env.MAX_WS_PER_CONVERSATION, DEFAULT_MAX_WS_PER_CONVERSATION),
    maxWsPerUser: intEnv(env.MAX_WS_PER_USER, DEFAULT_MAX_WS_PER_USER),
    maxWsPerUserGlobal: intEnv(env.MAX_WS_PER_USER_GLOBAL, DEFAULT_MAX_WS_PER_USER_GLOBAL),
    authFailBackoffBaseMs: intEnv(env.AUTH_FAIL_BACKOFF_BASE_MS, 1000),
    authFailBackoffMaxMs: intEnv(env.AUTH_FAIL_BACKOFF_MAX_MS, 15 * 60 * 1000),
    blocklistPhones: phones,
    blocklistIps: parseList(env.BLOCKLIST_IPS),
  };
}

export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const raw = cf || forwarded || "unknown";
  return IP_RE.test(raw) ? raw : "unknown";
}

export function parseCounter(raw: string | null, now: number): Counter | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Counter;
    if (!parsed || typeof parsed.count !== "number" || typeof parsed.resetAt !== "number") return null;
    if (now >= parsed.resetAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fixed window. `limit <= 0` or `windowMs <= 0` disables the limiter.
 * On deny, the stored counter is unchanged.
 */
export function advanceCounter(
  current: Counter | null,
  limit: number,
  windowMs: number,
  now: number,
): { ok: true; counter: Counter } | { ok: false; retryAfterSeconds: number; counter: Counter } {
  if (limit <= 0 || windowMs <= 0) {
    return { ok: true, counter: current ?? { count: 0, resetAt: now + 60_000 } };
  }
  if (!current || now >= current.resetAt) {
    return { ok: true, counter: { count: 1, resetAt: now + windowMs } };
  }
  if (current.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      counter: current,
    };
  }
  return { ok: true, counter: { count: current.count + 1, resetAt: current.resetAt } };
}

/** Returns Retry-After seconds when the window is exhausted, otherwise null. */
export async function takeLimit(
  kv: KvLike,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<number | null> {
  const current = parseCounter(await kv.get(key), now);
  const result = advanceCounter(current, limit, windowMs, now);
  if (!result.ok) return result.retryAfterSeconds;
  if (limit <= 0 || windowMs <= 0) return null;
  const ttl = Math.max(60, Math.ceil((result.counter.resetAt - now) / 1000));
  await kv.put(key, JSON.stringify(result.counter), { expirationTtl: ttl });
  return null;
}

export function parseFailState(raw: string | null): FailState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FailState;
    if (!parsed || typeof parsed.fails !== "number" || typeof parsed.lockedUntil !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Seconds remaining on an auth-failure lock, or null when the caller may try. */
export function lockRemaining(state: FailState | null, now: number): number | null {
  if (!state || now >= state.lockedUntil) return null;
  return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
}

/** Each failure doubles the wait, capped at `maxMs`. */
export function rejectionBackoff(
  state: FailState | null,
  now: number,
  baseMs: number,
  maxMs: number,
): { state: FailState; retryAfterSeconds: number } {
  const fails = (state?.fails ?? 0) + 1;
  const exponent = Math.min(fails - 1, 16);
  const delay = Math.min(maxMs, Math.max(1, baseMs) * 2 ** exponent);
  return {
    state: { fails, lockedUntil: now + delay },
    retryAfterSeconds: Math.max(1, Math.ceil(delay / 1000)),
  };
}

/**
 * Messages stay listable while `created_at` is after this floor.
 * `0` means the server ceiling is off (`MESSAGE_TTL_MS=0`). Disappearing
 * `expire_at` is a separate, sooner deadline.
 */
export function retentionFloor(now: number, ttlMs: number): number {
  if (ttlMs <= 0) return 0;
  return now - ttlMs;
}

/**
 * Attachment blob lifetime. A client `expireAt` (disappearing timer) wins when
 * it is sooner than the server ceiling. `ttlMs <= 0` keeps only the client deadline.
 */
export function attachmentExpireAt(now: number, requested: number | null, ttlMs: number): number | null {
  const ceiling = ttlMs > 0 ? now + ttlMs : null;
  if (requested == null) return ceiling;
  if (ceiling == null) return requested;
  return Math.min(requested, ceiling);
}

export function admitRoom(input: {
  roomTotal: number;
  roomForUser: number;
  maxPerConversation: number;
  maxPerUserInRoom: number;
}): Admit {
  if (input.roomTotal >= input.maxPerConversation) {
    return { ok: false, retryAfterSeconds: WS_REJECT_RETRY_AFTER_SEC, scope: "conversation" };
  }
  if (input.roomForUser >= input.maxPerUserInRoom) {
    return { ok: false, retryAfterSeconds: WS_REJECT_RETRY_AFTER_SEC, scope: "user" };
  }
  return { ok: true };
}

export function admitGlobal(count: number, max: number): Admit {
  if (count >= max) {
    return { ok: false, retryAfterSeconds: WS_REJECT_RETRY_AFTER_SEC, scope: "user_global" };
  }
  return { ok: true };
}
