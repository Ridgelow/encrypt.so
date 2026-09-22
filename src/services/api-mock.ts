import { ApiError } from "@/services/errors";
import type {
  AuthClient,
  DeviceResponse,
  GetPrekeyBundleResponse,
  MeResponse,
  OneTimePrekey,
  PrekeyBundleUpload,
  PublicPrekeyBundle,
  PutPrekeyBundleResponse,
  SessionResponse,
} from "@/services/api";

/** Worker stub SMS code. Anything else is rejected. */
export const STUB_VERIFY_CODE = "000000";

type StoredPrekey = OneTimePrekey & { consumed: boolean };

type StoredDevice = DeviceResponse & {
  identityKey: string | null;
  bundleUpdatedAt: number | null;
  signedPrekey: PrekeyBundleUpload["signedPrekey"] | null;
  oneTimePrekeys: StoredPrekey[];
};

type Session = { userId: string; phone: string };

/**
 * In-memory Auth worker. Request and response shapes match the locked routes.
 * Stored bundles are public fields only.
 */
export function createMockAuthClient(): AuthClient & {
  /** Public server state, for tests. Never includes private keys. */
  publicState(): unknown;
} {
  const challenges = new Map<string, { phone: string }>();
  const sessions = new Map<string, Session>();
  const users = new Map<string, { id: string; phone: string; createdAt: number }>();
  const devices = new Map<string, StoredDevice>();

  function requireUser(token: string): Session {
    const session = sessions.get(token);
    if (!session) throw new ApiError("invalid session", 401);
    return session;
  }

  function rejectPrivate(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) rejectPrivate(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (/private/i.test(key)) throw new ApiError("private keys are not accepted", 400);
      rejectPrivate(child);
    }
  }

  return {
    async startPhoneAuth(phone) {
      if (!phone.trim()) throw new ApiError("phone required", 400);
      const challengeId = crypto.randomUUID();
      challenges.set(challengeId, { phone });
      return { challengeId };
    },

    async verifyPhoneAuth(challengeId, code) {
      const challenge = challenges.get(challengeId);
      if (!challenge || code !== STUB_VERIFY_CODE) throw new ApiError("code rejected", 401);
      challenges.delete(challengeId);
      let user = [...users.values()].find((item) => item.phone === challenge.phone);
      if (!user) {
        user = { id: crypto.randomUUID(), phone: challenge.phone, createdAt: Date.now() };
        users.set(user.id, user);
      }
      const sessionToken = crypto.randomUUID();
      sessions.set(sessionToken, { userId: user.id, phone: user.phone });
      const response: SessionResponse = { sessionToken, userId: user.id };
      return response;
    },

    async getMe(token) {
      const session = requireUser(token);
      const user = users.get(session.userId);
      if (!user) throw new ApiError("invalid session", 401);
      const mine = [...devices.values()].filter((device) => device.userId === user.id);
      const response: MeResponse = {
        user: { id: user.id, phone: user.phone, createdAt: user.createdAt },
        devices: mine.map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          identityKey: device.identityKey,
          bundleUpdatedAt: device.bundleUpdatedAt,
        })),
      };
      return response;
    },

    async createDevice(token, name) {
      const session = requireUser(token);
      rejectPrivate({ name });
      const trimmed = name.trim();
      if (trimmed.length < 1 || trimmed.length > 64) throw new ApiError("invalid name", 400);
      const device: StoredDevice = {
        id: crypto.randomUUID(),
        userId: session.userId,
        name: trimmed,
        createdAt: Date.now(),
        identityKey: null,
        bundleUpdatedAt: null,
        signedPrekey: null,
        oneTimePrekeys: [],
      };
      devices.set(device.id, device);
      const response: DeviceResponse = {
        id: device.id,
        userId: device.userId,
        name: device.name,
        createdAt: device.createdAt,
      };
      return response;
    },

    async putPrekeyBundle(token, deviceId, bundle) {
      const session = requireUser(token);
      rejectPrivate(bundle);
      const device = devices.get(deviceId);
      if (!device || device.userId !== session.userId) throw new ApiError("device not found", 404);
      if (!Array.isArray(bundle.oneTimePrekeys)) throw new ApiError("oneTimePrekeys required", 400);
      device.identityKey = bundle.identityKey;
      device.signedPrekey = {
        keyId: bundle.signedPrekey.keyId,
        publicKey: bundle.signedPrekey.publicKey,
        signature: bundle.signedPrekey.signature,
      };
      device.oneTimePrekeys = bundle.oneTimePrekeys.map((prekey) => ({
        keyId: prekey.keyId,
        publicKey: prekey.publicKey,
        consumed: false,
      }));
      device.bundleUpdatedAt = Date.now();
      const response: PutPrekeyBundleResponse = {
        deviceId: device.id,
        bundleUpdatedAt: device.bundleUpdatedAt,
        oneTimePrekeyCount: device.oneTimePrekeys.length,
      };
      return response;
    },

    async getPrekeyBundle(token, userId) {
      requireUser(token);
      const mine = [...devices.values()].filter(
        (device) => device.userId === userId && device.identityKey && device.signedPrekey,
      );
      if (mine.length === 0) throw new ApiError("no prekey bundle", 404);
      const bundles: PublicPrekeyBundle[] = mine.map((device) => {
        const next = device.oneTimePrekeys.find((prekey) => !prekey.consumed) ?? null;
        if (next) next.consumed = true;
        return {
          deviceId: device.id,
          identityKey: device.identityKey as string,
          signedPrekey: device.signedPrekey as PublicPrekeyBundle["signedPrekey"],
          oneTimePrekey: next ? { keyId: next.keyId, publicKey: next.publicKey } : null,
        };
      });
      const response: GetPrekeyBundleResponse = { userId, bundles };
      return response;
    },

    publicState() {
      return {
        users: [...users.values()],
        devices: [...devices.values()].map((device) => ({
          id: device.id,
          userId: device.userId,
          name: device.name,
          identityKey: device.identityKey,
          signedPrekey: device.signedPrekey,
          oneTimePrekeys: device.oneTimePrekeys.map((prekey) => ({
            keyId: prekey.keyId,
            publicKey: prekey.publicKey,
            consumed: prekey.consumed,
          })),
        })),
      };
    },
  };
}
