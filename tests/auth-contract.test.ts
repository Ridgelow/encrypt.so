import { describe, expect, it } from "vitest";
import { createAuthClient, type PrekeyBundleUpload } from "../src/services/api";
import { ApiError } from "../src/services/errors";
import { createMockAuthClient, STUB_VERIFY_CODE } from "../src/services/api-mock";
import { ensureDeviceKeys } from "../src/e2ee/provision";
import { DEVICE_KEY_RECORD_KEY, parseRecord, privateMaterial } from "../src/e2ee/record";
import { createChunkedStore, type KeyValueStore } from "../src/e2ee/store";

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

const publicBundle: PrekeyBundleUpload = {
  identityKey: "aWRlbnRpdHkta2V5LXB1YmxpYw",
  signedPrekey: {
    keyId: 7,
    publicKey: "c2lnbmVkLXByZWtleS1wdWJsaWM",
    signature: "c2lnbmF0dXJlLXB1YmxpYy1vaw",
  },
  oneTimePrekeys: [
    { keyId: 1, publicKey: "b25lLXRpbWUtcHVla2V5LTE" },
    { keyId: 2, publicKey: "b25lLXRpbWUtcHVla2V5LTI" },
  ],
};

describe("locked auth contract", () => {
  it("mock: verify stub code, register device, publish and fetch a public bundle", async () => {
    const api = createMockAuthClient();
    const phone = await api.startPhoneAuth("+15550100192");
    expect(phone).toEqual({ challengeId: expect.any(String) });
    await expect(api.verifyPhoneAuth(phone.challengeId, "000001")).rejects.toBeInstanceOf(ApiError);

    const session = await api.verifyPhoneAuth(phone.challengeId, STUB_VERIFY_CODE);
    expect(session.sessionToken).toEqual(expect.any(String));
    expect(session.userId).toEqual(expect.any(String));

    const before = await api.getMe(session.sessionToken);
    expect(before.user.id).toBe(session.userId);
    expect(before.devices).toEqual([]);

    const device = await api.createDevice(session.sessionToken, "primary");
    expect(device).toMatchObject({ userId: session.userId, name: "primary" });

    const stored = await api.putPrekeyBundle(session.sessionToken, device.id, publicBundle);
    expect(stored).toMatchObject({
      deviceId: device.id,
      oneTimePrekeyCount: 2,
    });

    const first = await api.getPrekeyBundle(session.sessionToken, session.userId);
    expect(first.bundles).toEqual([
      {
        deviceId: device.id,
        identityKey: publicBundle.identityKey,
        signedPrekey: publicBundle.signedPrekey,
        oneTimePrekey: publicBundle.oneTimePrekeys[0],
      },
    ]);
    const second = await api.getPrekeyBundle(session.sessionToken, session.userId);
    expect(second.bundles[0]?.oneTimePrekey).toEqual(publicBundle.oneTimePrekeys[1]);

    await expect(
      api.putPrekeyBundle(session.sessionToken, device.id, {
        ...publicBundle,
        signedPrekey: { ...publicBundle.signedPrekey, privateKey: "c2VjcmV0LXZhbHVl" },
      } as PrekeyBundleUpload),
    ).rejects.toThrow(/private keys are not accepted/);
  });

  it("after auth, key lifecycle registers the device and uploads only public prekeys", async () => {
    const api = createMockAuthClient();
    const { challengeId } = await api.startPhoneAuth("+15550100193");
    const session = await api.verifyPhoneAuth(challengeId, "000000");
    const store = memoryStore();

    const result = await ensureDeviceKeys({
      store,
      session,
      api,
      apiOrigin: "http://127.0.0.1:8787",
      oneTimePreKeyCount: 2,
    });

    expect(result.uploaded).toBe(true);
    expect(result.serverDeviceId).toEqual(expect.any(String));
    const me = await api.getMe(session.sessionToken);
    expect(me.devices.map((device) => device.id)).toContain(result.serverDeviceId);
    expect(me.devices[0]?.identityKey).toBe(result.bundle.identityKey);

    const fetched = await api.getPrekeyBundle(session.sessionToken, session.userId);
    expect(fetched.bundles[0]?.signedPrekey).toEqual(result.bundle.signedPrekey);
    expect(fetched.bundles[0]?.oneTimePrekey?.publicKey).toBe(result.bundle.oneTimePrekeys[0]?.publicKey);

    const record = parseRecord((await store.getItem(DEVICE_KEY_RECORD_KEY)) ?? "");
    const published = JSON.stringify(api.publicState());
    expect(published.includes("privateKey")).toBe(false);
    for (const secret of privateMaterial(record)) {
      expect(published.includes(secret)).toBe(false);
    }
  });

  it("live client calls the locked paths and will not send a private field", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const client = createAuthClient({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        const raw = init?.body ? String(init.body) : "";
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          body: raw ? (JSON.parse(raw) as unknown) : null,
        });
        const path = String(url).replace("http://127.0.0.1:8787", "");
        if (path === "/auth/phone/start") return Response.json({ challengeId: "challenge-1" });
        if (path === "/auth/phone/verify") {
          return Response.json({ sessionToken: "token-1", userId: "user-1" });
        }
        if (path === "/me") {
          return Response.json({ user: { id: "user-1", phone: "+1555", createdAt: 1 }, devices: [] });
        }
        if (path === "/devices") {
          return Response.json({ id: "device-1", userId: "user-1", name: "primary", createdAt: 2 });
        }
        if (path === "/devices/device-1/prekey-bundle") {
          return Response.json({ deviceId: "device-1", bundleUpdatedAt: 3, oneTimePrekeyCount: 1 });
        }
        if (path === "/users/user-1/prekey-bundle") {
          return Response.json({
            userId: "user-1",
            bundles: [
              {
                deviceId: "device-1",
                identityKey: publicBundle.identityKey,
                signedPrekey: publicBundle.signedPrekey,
                oneTimePrekey: publicBundle.oneTimePrekeys[0],
              },
            ],
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const started = await client.startPhoneAuth("+15550100192");
    const session = await client.verifyPhoneAuth(started.challengeId, "000000");
    await client.getMe(session.sessionToken);
    const device = await client.createDevice(session.sessionToken, "primary");
    await client.putPrekeyBundle(session.sessionToken, device.id, {
      ...publicBundle,
      oneTimePrekeys: [publicBundle.oneTimePrekeys[0]!],
    });
    await client.getPrekeyBundle(session.sessionToken, session.userId);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8787/auth/phone/start",
      "POST http://127.0.0.1:8787/auth/phone/verify",
      "GET http://127.0.0.1:8787/me",
      "POST http://127.0.0.1:8787/devices",
      "PUT http://127.0.0.1:8787/devices/device-1/prekey-bundle",
      "GET http://127.0.0.1:8787/users/user-1/prekey-bundle",
    ]);
    expect(calls[0]?.body).toEqual({ phone: "+15550100192" });
    expect(calls[1]?.body).toEqual({ challengeId: "challenge-1", code: "000000" });
    expect(calls[2]?.authorization).toBe("Bearer token-1");
    expect(calls[3]?.body).toEqual({ name: "primary" });
    expect(calls[4]?.body).toEqual({
      identityKey: publicBundle.identityKey,
      signedPrekey: publicBundle.signedPrekey,
      oneTimePrekeys: [publicBundle.oneTimePrekeys[0]],
    });

    calls.length = 0;
    await expect(
      client.putPrekeyBundle(session.sessionToken, device.id, {
        ...publicBundle,
        privateKey: "c2VjcmV0LXZhbHVl",
      } as PrekeyBundleUpload),
    ).rejects.toThrow(/private keys are not accepted/);
    expect(calls).toHaveLength(0);
  });
});
