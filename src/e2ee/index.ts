import { createDevice, isApiConfigured, putPrekeyBundle } from "@/services/api";
import { loadSession } from "@/services/session";
import { DeviceKeyStoreUnavailableError } from "./errors";
import { createExpoKeyValueStore, isDeviceKeyStoreAvailable } from "./expo-key-store";
import { ensureDeviceKeys, type IdentityApi, type ProvisionResult } from "./provision";
import { createChunkedStore, type KeyValueStore } from "./store";

export { DeviceKeyError, DeviceKeyStoreUnavailableError, BundleUploadError } from "./errors";
export { ONE_TIME_PREKEY_COUNT, PRIMARY_DEVICE_NAME } from "./contract";
export type { ProvisionResult } from "./provision";

const api: IdentityApi = {
  createDevice,
  putPrekeyBundle,
};

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
    api: origin ? api : null,
    apiOrigin: origin,
    republish: options?.republish,
  });
}
