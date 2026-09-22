import { describe, expect, it } from "vitest";
import { ensureDeviceKeys } from "../src/e2ee/provision";
import { privateMaterial, DEVICE_KEY_RECORD_KEY, parseRecord } from "../src/e2ee/record";
import {
  fingerprintsMatch,
  readPeerVerification,
  safetyNumberForPeer,
  safetyNumberFromIdentities,
  setPeerVerified,
  verificationMatches,
  VERIFIED_PEERS_KEY,
} from "../src/e2ee/safety";
import { decryptFromPeer, encryptForPeer, ensureSessionWithUser } from "../src/e2ee/session";
import { createChunkedStore, type KeyValueStore } from "../src/e2ee/store";
import { decodeCompositeIdentityV1 } from "@open-e2ee/signal-protocol-sdk/keys";
import { base64ToBytes } from "@open-e2ee/signal-protocol-sdk/encoding";
import { createMockAuthClient, STUB_VERIFY_CODE } from "../src/services/api-mock";

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return createChunkedStore({
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async deleteItem(key) {
      map.delete(key);
    },
  });
}

async function provisionUser(api: ReturnType<typeof createMockAuthClient>, phone: string, store: KeyValueStore) {
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

async function identityOf(store: KeyValueStore) {
  const record = parseRecord((await store.getItem(DEVICE_KEY_RECORD_KEY)) as string);
  return decodeCompositeIdentityV1(
    base64ToBytes(record.identity.identityPublic as Parameters<typeof base64ToBytes>[0]),
  );
}

describe("safety numbers", () => {
  it("matches on both devices and stays pinned until the fingerprint changes", async () => {
    const api = createMockAuthClient();
    const aliceStore = memoryStore();
    const bobStore = memoryStore();
    const alice = await provisionUser(api, "+15550100011", aliceStore);
    const bob = await provisionUser(api, "+15550100012", bobStore);

    await ensureSessionWithUser({
      store: aliceStore,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: bob.userId,
      getPrekeyBundle: (token, userId) => api.getPrekeyBundle(token, userId),
    });
    const envelope = await encryptForPeer({
      store: aliceStore,
      localUserId: alice.userId,
      peerUserId: bob.userId,
      plaintext: "safety number round trip",
    });
    expect(
      await decryptFromPeer({ store: bobStore, localUserId: bob.userId, envelope }),
    ).toBe("safety number round trip");

    const aliceView = await safetyNumberForPeer({
      store: aliceStore,
      localUserId: alice.userId,
      peerUserId: bob.userId,
    });
    const bobView = await safetyNumberForPeer({
      store: bobStore,
      localUserId: bob.userId,
      peerUserId: alice.userId,
    });

    expect(aliceView.digits).toHaveLength(60);
    expect(aliceView.groups).toHaveLength(12);
    expect(aliceView.groups.every((group) => /^\d{5}$/.test(group))).toBe(true);
    expect(fingerprintsMatch(aliceView.numeric, bobView.digits)).toBe(true);
    expect(aliceView.digits).toBe(bobView.digits);

    const again = await safetyNumberForPeer({
      store: aliceStore,
      localUserId: alice.userId,
      peerUserId: bob.userId,
    });
    expect(again.digits).toBe(aliceView.digits);

    const aliceIdentity = await identityOf(aliceStore);
    const bobIdentity = await identityOf(bobStore);
    expect(
      safetyNumberFromIdentities(bobIdentity, aliceIdentity, bob.userId, alice.userId).digits,
    ).toBe(aliceView.digits);

    const secrets = [
      ...privateMaterial(parseRecord((await aliceStore.getItem(DEVICE_KEY_RECORD_KEY)) as string)),
      ...privateMaterial(parseRecord((await bobStore.getItem(DEVICE_KEY_RECORD_KEY)) as string)),
    ];
    const published = `${aliceView.numeric}${aliceView.hex}`;
    for (const secret of secrets) {
      expect(published.includes(secret)).toBe(false);
    }

    expect(await readPeerVerification(aliceStore, bob.userId)).toBeNull();
    await setPeerVerified(aliceStore, bob.userId, aliceView.digits, true, 50);
    const saved = await readPeerVerification(aliceStore, bob.userId);
    expect(saved).toEqual({ peerUserId: bob.userId, fingerprint: aliceView.digits, verifiedAt: 50 });
    expect(verificationMatches(saved, aliceView)).toBe(true);
    expect(verificationMatches(saved, { ...aliceView, digits: "1".repeat(60), numeric: "1".repeat(60) })).toBe(false);

    await setPeerVerified(aliceStore, bob.userId, aliceView.digits, false);
    expect(await readPeerVerification(aliceStore, bob.userId)).toBeNull();
    expect(await aliceStore.getItem(VERIFIED_PEERS_KEY)).toBeNull();
  });
});
