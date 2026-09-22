import {
  clientIp,
  loadGuardConfig,
  lockRemaining,
  normalizeBlockPhone,
  parseFailState,
  rejectionBackoff,
  takeLimit,
  type GuardConfig,
  type KvLike,
} from "./guard";
import { HttpError } from "./http";

export { clientIp };

export function sessionsKv(env: Env): KvLike {
  return {
    get: (key) => env.SESSIONS.get(key),
    put: (key, value, options) => env.SESSIONS.put(key, value, options),
    delete: (key) => env.SESSIONS.delete(key),
  };
}

export async function enforceLimit(kv: KvLike, key: string, limit: number, windowMs: number): Promise<void> {
  const retryAfter = await takeLimit(kv, key, limit, windowMs);
  if (retryAfter != null) throw new HttpError(429, "slow down", { retryAfter });
}

async function blocked(kv: KvLike, key: string): Promise<boolean> {
  const value = await kv.get(key);
  return value != null && value !== "" && value !== "0";
}

function listed(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/** Operator blocklist: env lists plus KV keys `block:ip:`, `block:phone:`, `block:user:`. */
export async function assertAllowed(
  env: Env,
  input: { ip?: string; phone?: string; userId?: string },
): Promise<void> {
  const config = loadGuardConfig(env);
  const kv = sessionsKv(env);
  if (input.ip && (listed(config.blocklistIps, input.ip) || (await blocked(kv, `block:ip:${input.ip}`)))) {
    throw new HttpError(403, "forbidden");
  }
  if (input.phone) {
    const phone = normalizeBlockPhone(input.phone) ?? input.phone;
    if (listed(config.blocklistPhones, phone) || (await blocked(kv, `block:phone:${phone}`))) {
      throw new HttpError(403, "forbidden");
    }
  }
  if (input.userId && (await blocked(kv, `block:user:${input.userId}`))) {
    throw new HttpError(403, "forbidden");
  }
}

const FAIL_PREFIX = "authfail:v1:";

export async function assertAuthUnlocked(env: Env, ip: string, now = Date.now()): Promise<void> {
  const state = parseFailState(await sessionsKv(env).get(`${FAIL_PREFIX}${ip}`));
  const retryAfter = lockRemaining(state, now);
  if (retryAfter != null) throw new HttpError(429, "slow down", { retryAfter });
}

export async function recordAuthFailure(env: Env, ip: string, config: GuardConfig, now = Date.now()): Promise<void> {
  const kv = sessionsKv(env);
  const key = `${FAIL_PREFIX}${ip}`;
  const next = rejectionBackoff(
    parseFailState(await kv.get(key)),
    now,
    config.authFailBackoffBaseMs,
    config.authFailBackoffMaxMs,
  );
  const ttl = Math.max(60, next.retryAfterSeconds);
  await kv.put(key, JSON.stringify(next.state), { expirationTtl: ttl });
}

export async function clearAuthFailure(env: Env, ip: string): Promise<void> {
  await sessionsKv(env).delete(`${FAIL_PREFIX}${ip}`);
}
