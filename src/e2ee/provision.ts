import type { PrekeyBundleUpload } from "@/services/api";
import { PRIMARY_DEVICE_NAME } from "./contract";
import { generateDeviceKeyRecord } from "./generate";
import {
  DEVICE_KEY_RECORD_KEY,
  parseRecord,
  privateMaterial,
  serializeRecord,
  toPrekeyBundleUpload,
  type PersistedDeviceKeys,
} from "./record";
import type { KeyValueStore } from "./store";
import { assertPublicBundle } from "./upload";

export interface IdentityApi {
  createDevice(token: string, name: string): Promise<{ id: string }>;
  putPrekeyBundle(
    token: string,
    deviceId: string,
    bundle: PrekeyBundleUpload,
  ): Promise<{ deviceId: string; oneTimePrekeyCount: number }>;
}

export interface ProvisionResult {
  created: boolean;
  uploaded: boolean;
  serverDeviceId: string | null;
  bundle: PrekeyBundleUpload;
}

export interface EnsureDeviceKeysInput {
  store: KeyValueStore;
  session: { sessionToken: string; userId: string } | null;
  api: IdentityApi | null;
  apiOrigin: string | null;
  oneTimePreKeyCount?: number;
  republish?: boolean;
  now?: number;
}

async function writeRecord(store: KeyValueStore, record: PersistedDeviceKeys): Promise<void> {
  await store.setItem(DEVICE_KEY_RECORD_KEY, serializeRecord(record));
}

async function readRecord(store: KeyValueStore): Promise<PersistedDeviceKeys | null> {
  const raw = await store.getItem(DEVICE_KEY_RECORD_KEY);
  if (raw == null) return null;
  return parseRecord(raw);
}

export async function ensureDeviceKeys(input: EnsureDeviceKeysInput): Promise<ProvisionResult> {
  let created = false;
  let record = await readRecord(input.store);
  if (!record) {
    record = await generateDeviceKeyRecord({
      oneTimePreKeyCount: input.oneTimePreKeyCount,
      now: input.now,
    });
    await writeRecord(input.store, record);
    created = true;
  }

  const bundle = toPrekeyBundleUpload(record);
  assertPublicBundle(bundle, privateMaterial(record));

  const canPublish = input.session !== null && input.api !== null && input.apiOrigin !== null;
  if (!canPublish) {
    return { created, uploaded: false, serverDeviceId: record.serverDeviceId, bundle };
  }

  const session = input.session;
  const api = input.api;
  const origin = input.apiOrigin;
  if (!session || !api || !origin) {
    return { created, uploaded: false, serverDeviceId: record.serverDeviceId, bundle };
  }

  let serverDeviceId = record.serverDeviceId;
  if (!serverDeviceId) {
    const device = await api.createDevice(session.sessionToken, PRIMARY_DEVICE_NAME);
    serverDeviceId = device.id;
    record = { ...record, serverDeviceId, publishedTo: null };
    await writeRecord(input.store, record);
  }

  const alreadyPublished = record.publishedTo === origin && !input.republish;
  if (alreadyPublished) {
    return { created, uploaded: false, serverDeviceId, bundle };
  }

  try {
    await api.putPrekeyBundle(session.sessionToken, serverDeviceId, bundle);
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    // Stale device id after re-login (or wiped D1 row) — register a fresh device and retry once.
    if (status !== 404) throw error;
    const device = await api.createDevice(session.sessionToken, PRIMARY_DEVICE_NAME);
    serverDeviceId = device.id;
    record = { ...record, serverDeviceId, publishedTo: null };
    await writeRecord(input.store, record);
    await api.putPrekeyBundle(session.sessionToken, serverDeviceId, bundle);
  }

  record = { ...record, publishedTo: origin, serverDeviceId };
  await writeRecord(input.store, record);
  return { created, uploaded: true, serverDeviceId, bundle };
}
