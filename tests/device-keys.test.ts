import { describe, expect, it } from "vitest";
import type { PrekeyBundleUpload } from "../src/services/api";
import { ONE_TIME_PREKEY_COUNT, PUBLIC_FIELD_MAX } from "../src/e2ee/contract";
import { generateDeviceKeyRecord } from "../src/e2ee/generate";
import { ensureDeviceKeys, type IdentityApi } from "../src/e2ee/provision";
import { privateMaterial, toPrekeyBundleUpload } from "../src/e2ee/record";
import { createChunkedStore, SECURE_STORE_VALUE_CHUNK, type KeyValueStore } from "../src/e2ee/store";
import { assertPublicBundle } from "../src/e2ee/upload";

function memoryStore(): { store: KeyValueStore; values: () => string[] } {
  const map = new Map<string, string>();
  const raw: KeyValueStore = {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async deleteItem(key) {
      map.delete(key);
    },
  };
  return {
    store: createChunkedStore(raw),
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

describe("device key lifecycle", () => {
  it("builds a public bundle the Auth worker can store", async () => {
    const record = await generateDeviceKeyRecord({ oneTimePreKeyCount: 4, now: 1 });
    const bundle = toPrekeyBundleUpload(record);

    expect(bundle.oneTimePrekeys).toHaveLength(4);
    expect(bundle.identityKey.length).toBeGreaterThanOrEqual(8);
    expect(bundle.identityKey.length).toBeLessThanOrEqual(PUBLIC_FIELD_MAX);
    expect(bundle.signedPrekey.publicKey.length).toBeLessThanOrEqual(PUBLIC_FIELD_MAX);
    expect(bundle.signedPrekey.signature.length).toBeLessThanOrEqual(PUBLIC_FIELD_MAX);
    expect(new Set(bundle.oneTimePrekeys.map((prekey) => prekey.keyId)).size).toBe(4);
    expect(fieldNames(bundle).some((name) => /private/i.test(name))).toBe(false);
    expect(bundle.identityKey).not.toBe(record.identity.dhPublicKey);
    expect(bundle.identityKey).not.toBe(record.identity.signingPublicKey);

    const body = JSON.stringify(bundle);
    for (const secret of privateMaterial(record)) {
      expect(body.includes(secret)).toBe(false);
    }
    expect(body.includes(record.kyberPreKey.publicKey)).toBe(false);
    expect(body.includes(record.kyberPreKey.privateKey)).toBe(false);
    assertPublicBundle(bundle, privateMaterial(record));
  });

  it("generates the worker's one-time prekey pool size", async () => {
    const record = await generateDeviceKeyRecord();
    expect(record.oneTimePreKeys).toHaveLength(ONE_TIME_PREKEY_COUNT);
    expect(toPrekeyBundleUpload(record).oneTimePrekeys).toHaveLength(ONE_TIME_PREKEY_COUNT);
    expect(record.identity.registrationId).toBeGreaterThanOrEqual(1);
    expect(record.identity.registrationId).toBeLessThanOrEqual(16383);
  });

  it("persists private material in chunked secure-store values and uploads once", async () => {
    const { store, values } = memoryStore();
    const uploads: PrekeyBundleUpload[] = [];
    let creates = 0;
    const api: IdentityApi = {
      async createDevice() {
        creates += 1;
        return { id: "11111111-1111-1111-1111-111111111111" };
      },
      async putPrekeyBundle(_token, deviceId, bundle) {
        uploads.push(bundle);
        return { deviceId, oneTimePrekeyCount: bundle.oneTimePrekeys.length };
      },
    };
    const session = { sessionToken: "session-token", userId: "user-1" };

    const first = await ensureDeviceKeys({
      store,
      session,
      api,
      apiOrigin: "http://127.0.0.1:8787",
      oneTimePreKeyCount: 3,
    });
    const second = await ensureDeviceKeys({
      store,
      session,
      api,
      apiOrigin: "http://127.0.0.1:8787",
      oneTimePreKeyCount: 3,
    });

    expect(first.created).toBe(true);
    expect(first.uploaded).toBe(true);
    expect(first.serverDeviceId).toBe("11111111-1111-1111-1111-111111111111");
    expect(second.created).toBe(false);
    expect(second.uploaded).toBe(false);
    expect(second.bundle.identityKey).toBe(first.bundle.identityKey);
    expect(creates).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.oneTimePrekeys).toHaveLength(3);

    const stored = values();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((value) => value.length <= SECURE_STORE_VALUE_CHUNK)).toBe(true);
    const uploadBody = JSON.stringify(uploads[0]);
    const storedBody = stored.join("");
    expect(storedBody.length).toBeGreaterThan(uploadBody.length);
    expect(storedBody.includes(first.bundle.signedPrekey.publicKey)).toBe(true);
    expect(uploadBody.includes("privateKey")).toBe(false);
  });

  it("keeps keys local when there is no session", async () => {
    const { store } = memoryStore();
    let called = false;
    const api: IdentityApi = {
      async createDevice() {
        called = true;
        return { id: "nope" };
      },
      async putPrekeyBundle() {
        called = true;
        return { deviceId: "nope", oneTimePrekeyCount: 0 };
      },
    };
    const result = await ensureDeviceKeys({
      store,
      session: null,
      api,
      apiOrigin: "http://127.0.0.1:8787",
      oneTimePreKeyCount: 2,
    });
    expect(result.uploaded).toBe(false);
    expect(result.serverDeviceId).toBeNull();
    expect(called).toBe(false);
  });

  it("refuses a bundle that names a private field", () => {
    const bundle = {
      identityKey: "aWRlbnRpdHkta2V5",
      signedPrekey: {
        keyId: 1,
        publicKey: "cHVibGljLWtleS1vaw",
        signature: "c2lnbmF0dXJlLW9r",
        privateKey: "c2VjcmV0",
      },
      oneTimePrekeys: [{ keyId: 1, publicKey: "b25lLXRpbWUta2V5" }],
    } as PrekeyBundleUpload;

    expect(() => assertPublicBundle(bundle, [])).toThrow(/private_key/);
  });
});
