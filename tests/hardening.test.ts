import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HttpError, errorResponse } from "../workers/src/http";
import {
  admitGlobal,
  admitRoom,
  advanceCounter,
  attachmentExpireAt,
  loadGuardConfig,
  lockRemaining,
  normalizeBlockPhone,
  parseCounter,
  rejectionBackoff,
  retentionFloor,
  takeLimit,
  type KvLike,
} from "../workers/src/guard";

function memoryKv(): KvLike & { snapshot(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    snapshot: () => map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

describe("rate limits", () => {
  it("fills a fixed window and reports Retry-After without extending it", async () => {
    const kv = memoryKv();
    const start = 1_000_000;
    expect(await takeLimit(kv, "k", 2, 60_000, start)).toBeNull();
    expect(await takeLimit(kv, "k", 2, 60_000, start + 10)).toBeNull();
    const retry = await takeLimit(kv, "k", 2, 60_000, start + 1_000);
    expect(retry).toBe(59);
    const stored = parseCounter(kv.snapshot().get("k") ?? null, start + 1_000);
    expect(stored).toEqual({ count: 2, resetAt: start + 60_000 });
    expect(await takeLimit(kv, "k", 2, 60_000, start + 60_000)).toBeNull();
  });

  it("treats a non-positive limit as disabled", () => {
    const decision = advanceCounter(null, 0, 60_000, 10);
    expect(decision.ok).toBe(true);
  });

  it("doubles auth-failure backoff and stops at the cap", () => {
    const first = rejectionBackoff(null, 5_000, 1_000, 10_000);
    expect(first.retryAfterSeconds).toBe(1);
    expect(lockRemaining(first.state, 5_000)).toBe(1);
    expect(lockRemaining(first.state, 6_000)).toBeNull();
    const second = rejectionBackoff(first.state, 7_000, 1_000, 10_000);
    expect(second.state.fails).toBe(2);
    expect(second.retryAfterSeconds).toBe(2);
    const capped = rejectionBackoff({ fails: 20, lockedUntil: 0 }, 9_000, 1_000, 3_000);
    expect(capped.retryAfterSeconds).toBe(3);
  });
});

describe("retention and connection caps", () => {
  it("keeps a disappearing deadline when it is sooner than the server ceiling", () => {
    const now = 1_000_000;
    const week = now + 7 * 24 * 60 * 60 * 1000;
    const ceiling = now + 30 * 24 * 60 * 60 * 1000;
    expect(attachmentExpireAt(now, week, 30 * 24 * 60 * 60 * 1000)).toBe(week);
    expect(attachmentExpireAt(now, ceiling + 1, 30 * 24 * 60 * 60 * 1000)).toBe(ceiling);
    expect(attachmentExpireAt(now, null, 30 * 24 * 60 * 60 * 1000)).toBe(ceiling);
    expect(attachmentExpireAt(now, week, 0)).toBe(week);
    expect(retentionFloor(now, 0)).toBe(0);
    expect(retentionFloor(now, 1_000)).toBe(now - 1_000);
  });

  it("rejects the next socket once a conversation or a user is at the cap", () => {
    expect(
      admitRoom({ roomTotal: 1, roomForUser: 0, maxPerConversation: 2, maxPerUserInRoom: 2 }),
    ).toEqual({ ok: true });
    expect(
      admitRoom({ roomTotal: 2, roomForUser: 0, maxPerConversation: 2, maxPerUserInRoom: 8 }).ok,
    ).toBe(false);
    const perUser = admitRoom({ roomTotal: 3, roomForUser: 2, maxPerConversation: 32, maxPerUserInRoom: 2 });
    expect(perUser.ok).toBe(false);
    if (!perUser.ok) expect(perUser.scope).toBe("user");
    expect(admitGlobal(16, 16).ok).toBe(false);
    expect(admitGlobal(15, 16).ok).toBe(true);
  });

  it("reads defaults and normalizes blocklist phones", () => {
    const config = loadGuardConfig({});
    expect(config.authStartPerPhone).toBe(8);
    expect(config.messageTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.maxCiphertextChars).toBe(49152);
    expect(config.maxWsPerUser).toBe(8);
    const listed = loadGuardConfig({ BLOCKLIST_PHONES: "15551212000, nope", BLOCKLIST_IPS: "203.0.113.4" });
    expect(listed.blocklistPhones).toEqual(["+15551212000"]);
    expect(listed.blocklistIps).toEqual(["203.0.113.4"]);
    expect(normalizeBlockPhone("+1 (555) 121-2000")).toBe("+15551212000");
  });
});

describe("abuse responses", () => {
  it("returns 429 with Retry-After and does not echo a body", async () => {
    const response = errorResponse(new HttpError(429, "slow down", { retryAfter: 12 }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toEqual({ error: "slow down", retryAfter: 12 });
  });

  it("retention migration has no plaintext column", () => {
    const sql = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../workers/migrations/0004_retention.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE attachment_objects/);
    expect(sql).toMatch(/object_key TEXT PRIMARY KEY/);
    const tables = sql.replace(/--[^\n]*/g, "");
    expect(tables).not.toMatch(/\b(plaintext|filename|content_key|private_key)\b/i);
  });
});
