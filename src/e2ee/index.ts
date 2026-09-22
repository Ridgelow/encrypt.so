import { createAuthClient, isApiConfigured } from "@/services/api";
import { loadSession } from "@/services/session";
import { DeviceKeyStoreUnavailableError, SessionUnavailableError } from "./errors";
import { createExpoKeyValueStore, isDeviceKeyStoreAvailable } from "./expo-key-store";
import { ensureDeviceKeys, type IdentityApi, type ProvisionResult } from "./provision";
import {
  decryptFromPeer as decryptFromPeerWith,
  encryptForPeer as encryptForPeerWith,
  ensureSessionWithUser as ensureSessionWithUserWith,
  establishedSession,
  type EstablishedSession,
  type OpaqueEnvelope,
} from "./session";
import { createChunkedStore, type KeyValueStore } from "./store";

export { DeviceKeyError, DeviceKeyStoreUnavailableError, BundleUploadError } from "./errors";
export {
  SessionBundleError,
  SessionKeysMissingError,
  SessionLeakError,
  SessionMessageError,
  SessionNotEstablishedError,
  SessionRecordError,
  SessionUnavailableError,
} from "./errors";
export { ONE_TIME_PREKEY_COUNT, PRIMARY_DEVICE_NAME } from "./contract";
export { isPeerUserId } from "./session";
export type { ProvisionResult } from "./provision";
export type { EstablishedSession, OpaqueEnvelope } from "./session";

function liveApi(origin: string): IdentityApi {
  const client = createAuthClient({ baseUrl: origin });
  return {
    createDevice: (token, name) => client.createDevice(token, name),
    putPrekeyBundle: (token, deviceId, bundle) => client.putPrekeyBundle(token, deviceId, bundle),
  };
}

let store: KeyValueStore | null = null;
let inflight: Promise<ProvisionResult> | null = null;

function deviceStore(): KeyValueStore {
  if (!store) store = createChunkedStore(createExpoKeyValueStore());
  return store;
}

function apiOrigin(): string | null {
  if (!isApiConfigured()) return null;
  const raw = process.env.EXPO_PUBLIC_API_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

/**
 * First-login / device registration.
 *
 * Generates identity, signed prekey, one-time prekeys, and a local ML-KEM
 * last-resort prekey. Private keys are written only to Secure Store. When a
 * session and `EXPO_PUBLIC_API_URL` are present, creates the device and
 * uploads the public bundle to the Auth worker.
 */
export function provisionDeviceKeys(options?: { republish?: boolean }): Promise<ProvisionResult> {
  if (inflight && !options?.republish) return inflight;
  inflight = run(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function run(options?: { republish?: boolean }): Promise<ProvisionResult> {
  if (!(await isDeviceKeyStoreAvailable())) {
    throw new DeviceKeyStoreUnavailableError();
  }
  const origin = apiOrigin();
  return ensureDeviceKeys({
    store: deviceStore(),
    session: await loadSession(),
    api: origin ? liveApi(origin) : null,
    apiOrigin: origin,
    republish: options?.republish,
  });
}

async function readyStore(): Promise<{ store: KeyValueStore; localUserId: string; sessionToken: string }> {
  if (!(await isDeviceKeyStoreAvailable())) throw new DeviceKeyStoreUnavailableError();
  const session = await loadSession();
  if (!session) throw new SessionUnavailableError();
  return { store: deviceStore(), localUserId: session.userId, sessionToken: session.sessionToken };
}

/**
 * Open a 1:1 Signal session with `peerUserId` using
 * `GET /users/:userId/prekey-bundle`. Reuses a session already in Secure Store.
 */
export async function ensureSessionWithUser(peerUserId: string): Promise<EstablishedSession> {
  const ready = await readyStore();
  const existing = await establishedSession(ready.store, peerUserId);
  if (existing) return existing;
  const origin = apiOrigin();
  if (!origin) throw new SessionUnavailableError();
  const client = createAuthClient({ baseUrl: origin });
  return ensureSessionWithUserWith({
    store: ready.store,
    localUserId: ready.localUserId,
    sessionToken: ready.sessionToken,
    peerUserId,
    getPrekeyBundle: (token, userId) => client.getPrekeyBundle(token, userId),
  });
}

/** Encrypt for a peer that already has a session. The envelope is opaque. */
export async function encryptForPeer(peerUserId: string, plaintext: string): Promise<OpaqueEnvelope> {
  const ready = await readyStore();
  return encryptForPeerWith({
    store: ready.store,
    localUserId: ready.localUserId,
    peerUserId,
    plaintext,
  });
}

/** Decrypt an envelope addressed to this device, establishing the session on a first message. */
export async function decryptFromPeer(envelope: OpaqueEnvelope): Promise<string> {
  const ready = await readyStore();
  return decryptFromPeerWith({
    store: ready.store,
    localUserId: ready.localUserId,
    envelope,
  });
}
