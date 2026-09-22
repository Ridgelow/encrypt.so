import { describe, expect, it } from "vitest";
import type { OpaqueEnvelope } from "../src/e2ee/session";
import { createMemoryStore } from "../src/e2ee/store";
import type { CiphertextMessage, MessagingClient } from "../src/services/api";
import {
  ciphertextToEnvelope,
  ENVELOPE_CONTENT_TYPE,
  envelopeToCiphertext,
  postBodyForEnvelope,
  sendDisappearingCiphertext,
} from "../src/services/ciphertext";
import {
  createTimerPrefs,
  durationMs,
  expireAtForChoice,
  isExpired,
  purgeDelay,
  systemLineForTimer,
} from "../src/services/disappear";
import { createMessageCache } from "../src/services/messageCache";

const envelope: OpaqueEnvelope = {
  version: 1,
  senderUserId: "11111111-1111-4111-8111-111111111111",
  senderDeviceId: "22222222-2222-4222-8222-222222222222",
  recipientUserId: "33333333-3333-4333-8333-333333333333",
  recipientDeviceId: "44444444-4444-4444-8444-444444444444",
  ciphertext: "b3BhcXVlLWNpcGhlcnRleHQtYmxvYg==",
};

const plaintext = "hello from the clear — must not be posted";

describe("disappearing messages", () => {
  it("maps the thread timer onto expireAt and omits it when off", () => {
    expect(durationMs("Off")).toBeNull();
    expect(durationMs("30 seconds")).toBe(30_000);
    expect(durationMs("5 minutes")).toBe(5 * 60_000);
    expect(durationMs("1 hour")).toBe(60 * 60_000);
    expect(expireAtForChoice("Off", 1_000)).toBeUndefined();
    expect(expireAtForChoice("30 seconds", 1_000)).toBe(31_000);
    expect(expireAtForChoice("5 minutes", 1_000)).toBe(1_000 + 5 * 60_000);
    expect(expireAtForChoice("1 hour", 1_000)).toBe(1_000 + 60 * 60_000);
    expect(isExpired(31_000, 31_000)).toBe(true);
    expect(isExpired(31_000, 30_999)).toBe(false);
    expect(isExpired(null, 31_000)).toBe(false);
    expect(purgeDelay(31_000, 1_000)).toBe(30_000);
    expect(purgeDelay(1_000, 2_000)).toBe(0);
    expect(purgeDelay(undefined, 1_000)).toBeNull();
    expect(systemLineForTimer("30 seconds")).toBe("— Disappearing messages: 30 seconds —");
    expect(systemLineForTimer("Off")).toBe("— Disappearing messages off —");
  });

  it("posts opaque ciphertext with expireAt and never a plaintext field", async () => {
    const calls: Array<{ peerUserId?: string; body?: unknown }> = [];
    const stored: CiphertextMessage = {
      id: "55555555-5555-4555-8555-555555555555",
      conversationId: "66666666-6666-4666-8666-666666666666",
      senderDeviceId: envelope.senderDeviceId,
      ciphertext: envelopeToCiphertext(envelope),
      contentType: ENVELOPE_CONTENT_TYPE,
      createdAt: 10,
      expireAt: 40_000,
      clientId: "msg-1",
    };
    const client: Pick<MessagingClient, "createConversation" | "postMessage"> = {
      async createConversation(_token, peerUserId) {
        calls.push({ peerUserId });
        return {
          id: stored.conversationId,
          createdAt: 1,
          members: [],
        };
      },
      async postMessage(_token, _conversationId, body) {
        calls.push({ body });
        return { ...stored, ciphertext: body.ciphertext, expireAt: body.expireAt ?? null };
      },
    };

    const posted = await sendDisappearingCiphertext({
      client,
      token: "token-1",
      peerUserId: envelope.recipientUserId,
      envelope,
      clientId: "msg-1",
      expireAt: 40_000,
    });

    expect(posted.expireAt).toBe(40_000);
    expect(calls[0]).toEqual({ peerUserId: envelope.recipientUserId });
    const body = calls[1]?.body as Record<string, unknown>;
    expect(body).toEqual({
      ciphertext: envelopeToCiphertext(envelope),
      contentType: ENVELOPE_CONTENT_TYPE,
      clientId: "msg-1",
      senderDeviceId: envelope.senderDeviceId,
      expireAt: 40_000,
    });
    expect(body).not.toHaveProperty("plaintext");
    expect(body).not.toHaveProperty("text");
    expect(JSON.stringify(body).includes(plaintext)).toBe(false);
    expect(/^[A-Za-z0-9+/_-]{4,49152}={0,2}$/.test(String(body.ciphertext))).toBe(true);
    expect(/^[\w!#$&^_.+-]{1,64}(?:\/[\w!#$&^_.+-]{1,64})?$/.test(ENVELOPE_CONTENT_TYPE)).toBe(true);
    expect(ciphertextToEnvelope(String(body.ciphertext))).toEqual(envelope);

    const persistent = postBodyForEnvelope(envelope, { clientId: "msg-2" });
    expect(persistent.expireAt).toBeUndefined();
    expect(Object.keys(persistent)).not.toContain("plaintext");
  });

  it("purges expired plaintext from the local cache and remembers the timer", async () => {
    const store = createMemoryStore();
    const cache = createMessageCache(store);
    await cache.save({ id: "keep", conversationId: "c1", plaintext: "stay", createdAt: 1 });
    await cache.save({
      id: "drop",
      conversationId: "c1",
      plaintext: "gone",
      createdAt: 2,
      expireAt: 1_000,
    });
    expect(await cache.purgeExpired(1_000)).toEqual(["drop"]);
    expect(await cache.list("c1")).toEqual([
      { id: "keep", conversationId: "c1", plaintext: "stay", createdAt: 1 },
    ]);
    expect(await cache.purgeExpired(5_000)).toEqual([]);

    const prefs = createTimerPrefs(store);
    expect(await prefs.load("sam")).toBeNull();
    await prefs.save("sam", "5 minutes");
    await prefs.save("sam", "not a timer");
    expect(await prefs.load("sam")).toBe("5 minutes");
    await prefs.save("sam", "Off");
    expect(await prefs.load("sam")).toBe("Off");
  });
});
