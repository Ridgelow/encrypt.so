import { describe, expect, it } from "vitest";
import { ensureDeviceKeys } from "../src/e2ee/provision";
import { DEVICE_KEY_RECORD_KEY, parseRecord, privateMaterial } from "../src/e2ee/record";
import {
  decryptFromPeer,
  encryptForPeer,
  ensureSessionWithUser,
  isPeerUserId,
  type OpaqueEnvelope,
} from "../src/e2ee/session";
import { SessionBundleError, SessionNotEstablishedError } from "../src/e2ee/errors";
import { createChunkedStore, SECURE_STORE_VALUE_CHUNK, type KeyValueStore } from "../src/e2ee/store";
import { createMockAuthClient, STUB_VERIFY_CODE } from "../src/services/api-mock";

function memoryStore(): { store: KeyValueStore; values: () => string[] } {
  const map = new Map<string, string>();
  return {
    store: createChunkedStore({
      async getItem(key) {
        return map.get(key) ?? null;
      },
      async setItem(key, value) {
        map.set(key, value);
      },
      async deleteItem(key) {
        map.delete(key);
      },
    }),
    values: () => [...map.values()],
  };
}

function fieldNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) fieldNames(item, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      fieldNames(child, found);
    }
  }
  return found;
}

async function provisionUser(
  api: ReturnType<typeof createMockAuthClient>,
  phone: string,
  store: KeyValueStore,
) {
  const challenge = await api.startPhoneAuth(phone);
  const session = await api.verifyPhoneAuth(challenge.challengeId, STUB_VERIFY_CODE);
  await ensureDeviceKeys({
    store,
    session,
    api,
    apiOrigin: "http://127.0.0.1:8787",
    oneTimePreKeyCount: 3,
  });
  return session;
}

describe("1:1 signal sessions", () => {
  it("recognizes worker user ids and leaves mock chat ids alone", () => {
    expect(isPeerUserId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isPeerUserId("sam")).toBe(false);
    expect(isPeerUserId(undefined)).toBe(false);
  });

  it("round-trips a session through a consumed prekey bundle without leaking private keys", async () => {
    const api = createMockAuthClient();
    const aliceStore = memoryStore();
    const bobStore = memoryStore();
    const alice = await provisionUser(api, "+15550100001", aliceStore.store);
    const bob = await provisionUser(api, "+15550100002", bobStore.store);
    const fetches: Array<{ token: string; userId: string }> = [];
    const getPrekeyBundle = async (token: string, userId: string) => {
      fetches.push({ token, userId });
      return api.getPrekeyBundle(token, userId);
    };

    const established = await ensureSessionWithUser({
      store: aliceStore.store,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: bob.userId,
      getPrekeyBundle,
    });
    const again = await ensureSessionWithUser({
      store: aliceStore.store,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: bob.userId,
      getPrekeyBundle,
    });

    expect(established.created).toBe(true);
    expect(established.peerUserId).toBe(bob.userId);
    expect(again).toEqual({ ...established, created: false });
    expect(fetches).toEqual([{ token: alice.sessionToken, userId: bob.userId }]);

    const first = await encryptForPeer({
      store: aliceStore.store,
      localUserId: alice.userId,
      peerUserId: bob.userId,
      plaintext: "hello from alice — session round trip",
    });
    const opened = await decryptFromPeer({
      store: bobStore.store,
      localUserId: bob.userId,
      envelope: first,
    });
    expect(opened).toBe("hello from alice — session round trip");

    const reply = await encryptForPeer({
      store: bobStore.store,
      localUserId: bob.userId,
      peerUserId: alice.userId,
      plaintext: "hello from bob — session round trip",
    });
    const back = await decryptFromPeer({
      store: aliceStore.store,
      localUserId: alice.userId,
      envelope: reply,
    });
    expect(back).toBe("hello from bob — session round trip");

    const followUp = await encryptForPeer({
      store: aliceStore.store,
      localUserId: alice.userId,
      peerUserId: bob.userId,
      plaintext: "second alice message after the ratchet",
    });
    expect(
      await decryptFromPeer({
        store: bobStore.store,
        localUserId: bob.userId,
        envelope: followUp,
      }),
    ).toBe("second alice message after the ratchet");

    expect(fetches).toHaveLength(1);
    const published = api.publicState() as {
      devices: Array<{
        userId: string;
        oneTimePrekeys: Array<{ consumed: boolean; publicKey: string }>;
      }>;
    };
    const bobDevice = published.devices.find((device) => device.userId === bob.userId);
    expect(bobDevice?.oneTimePrekeys.filter((prekey) => prekey.consumed)).toHaveLength(1);
    expect(fieldNames(published).some((name) => /private/i.test(name))).toBe(false);

    const aliceRecord = parseRecord((await aliceStore.store.getItem(DEVICE_KEY_RECORD_KEY)) as string);
    const bobRecord = parseRecord((await bobStore.store.getItem(DEVICE_KEY_RECORD_KEY)) as string);
    expect(bobRecord.oneTimePreKeys.length).toBe(2);
    assertEnvelopeIsOpaque(first, [...privateMaterial(aliceRecord), ...privateMaterial(bobRecord)]);
    assertEnvelopeIsOpaque(reply, [...privateMaterial(aliceRecord), ...privateMaterial(bobRecord)]);
    assertEnvelopeIsOpaque(followUp, [...privateMaterial(aliceRecord), ...privateMaterial(bobRecord)]);

    const aliceBody = aliceStore.values().join("");
    const bobBody = bobStore.values().join("");
    expect(aliceStore.values().every((value) => value.length <= SECURE_STORE_VALUE_CHUNK)).toBe(true);
    expect(bobStore.values().every((value) => value.length <= SECURE_STORE_VALUE_CHUNK)).toBe(true);
    expect(aliceBody.includes(aliceRecord.identity.dhPrivateKey)).toBe(true);
    expect(bobBody.includes(bobRecord.identity.dhPrivateKey)).toBe(true);
    expect(JSON.stringify(published).includes(aliceRecord.identity.dhPrivateKey)).toBe(false);
    expect(JSON.stringify(published).includes(bobRecord.identity.dhPrivateKey)).toBe(false);
  });

  it("does not encrypt before a session exists and ignores a missing bundle", async () => {
    const api = createMockAuthClient();
    const aliceStore = memoryStore();
    const alice = await provisionUser(api, "+15550100003", aliceStore.store);
    await expect(
      encryptForPeer({
        store: aliceStore.store,
        localUserId: alice.userId,
        peerUserId: "22222222-2222-4222-8222-222222222222",
        plaintext: "no session yet",
      }),
    ).rejects.toBeInstanceOf(SessionNotEstablishedError);
    await expect(
      ensureSessionWithUser({
        store: aliceStore.store,
        localUserId: alice.userId,
        sessionToken: alice.sessionToken,
        peerUserId: "22222222-2222-4222-8222-222222222222",
        getPrekeyBundle: (token, userId) => api.getPrekeyBundle(token, userId),
      }),
    ).rejects.toBeInstanceOf(SessionBundleError);
  });
});

function assertEnvelopeIsOpaque(envelope: OpaqueEnvelope, secrets: readonly string[]): void {
  expect(envelope.version).toBe(1);
  expect(envelope.ciphertext).not.toContain("hello from");
  expect(fieldNames(envelope).some((name) => /private/i.test(name))).toBe(false);
  const body = JSON.stringify(envelope);
  for (const secret of secrets) {
    expect(body.includes(secret)).toBe(false);
  }
}
