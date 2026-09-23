import {
  createSignalProtocolClient,
  PostQuantumPolicy,
  ProtocolAddress,
  type SignalProtocolClient,
} from "@open-e2ee/signal-protocol-sdk";
import { base64ToBytes } from "@open-e2ee/signal-protocol-sdk/encoding";
import {
  decodeCompositeIdentityV1,
  type Ciphertext,
  type CompositeIdentityV1,
  type PreKeyBundle,
  type PrivateKey,
} from "@open-e2ee/signal-protocol-sdk/keys";
import {
  inMemoryStore,
  type InMemorySignalProtocolStore,
} from "@open-e2ee/signal-protocol-sdk/local/store/memory";
import type { GetPrekeyBundleResponse, PublicPrekeyBundle } from "@/services/api";
import {
  SessionBundleError,
  SessionKeysMissingError,
  SessionLeakError,
  SessionMessageError,
  SessionNotEstablishedError,
  SessionRecordError,
} from "./errors";
import {
  asPublicKey,
  asSignature,
  DEVICE_KEY_RECORD_KEY,
  parseRecord,
  privateMaterial,
  serializeRecord,
  type PersistedDeviceKeys,
} from "./record";
import {
  locatorFor,
  protocolDeviceIdFor,
  readPeerSession,
  readSessionIndex,
  writePeerSession,
  type SessionLocator,
} from "./session-store";
import { assertSecureStoreKey, type KeyValueStore } from "./store";

/** SDK bundle validator accepts registration ids in `1..16383`. */
const REGISTRATION_ID_SPACE = 16383;

/** This install is one Signal device. The worker device id is stored separately. */
export const LOCAL_PROTOCOL_DEVICE_ID = 1;

const PEER_USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SILENT_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  breadcrumb() {},
};

type SdkSessionRecord = NonNullable<
  Awaited<ReturnType<InMemorySignalProtocolStore["getSessionRecord"]>>
>;

export interface OpaqueEnvelope {
  version: 1;
  senderUserId: string;
  senderDeviceId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  /** SDK ciphertext, standard base64. Not plaintext. */
  ciphertext: string;
}

export interface EstablishedSession {
  peerUserId: string;
  peerDeviceId: string;
  created: boolean;
}

export interface EnsureSessionInput {
  store: KeyValueStore;
  localUserId: string;
  sessionToken: string;
  peerUserId: string;
  getPrekeyBundle: (token: string, userId: string) => Promise<GetPrekeyBundleResponse>;
}

export interface EncryptForPeerInput {
  store: KeyValueStore;
  localUserId: string;
  peerUserId: string;
  peerDeviceId?: string;
  plaintext: string;
}

export interface DecryptFromPeerInput {
  store: KeyValueStore;
  localUserId: string;
  envelope: OpaqueEnvelope;
}

export interface OpenedClient {
  signal: SignalProtocolClient;
  storage: InMemorySignalProtocolStore;
  device: PersistedDeviceKeys;
  index: Awaited<ReturnType<typeof readSessionIndex>>;
}

/** True for account ids issued by the Auth worker. Mock chat ids are not. */
export function isPeerUserId(value: string | null | undefined): value is string {
  return typeof value === "string" && PEER_USER_ID.test(value);
}

/**
 * The worker does not store registration ids. The SDK still requires one on a
 * bundle. This value is stable for an identity key and is not an X3DH input.
 */
export function registrationIdFromIdentity(identityKey: string): number {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(identityKey as Parameters<typeof base64ToBytes>[0]);
  } catch {
    throw new SessionBundleError();
  }
  if (bytes.length < 3) throw new SessionBundleError();
  const raw = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  return (raw % REGISTRATION_ID_SPACE) + 1;
}

/** Prefer a device that still has a one-time prekey. */
export function pickDeviceBundle(bundles: readonly PublicPrekeyBundle[]): PublicPrekeyBundle | null {
  if (bundles.length === 0) return null;
  return bundles.find((bundle) => bundle.oneTimePrekey !== null) ?? bundles[0] ?? null;
}

export function toSdkPreKeyBundle(bundle: PublicPrekeyBundle, protocolDeviceId: number): PreKeyBundle {
  if (!Number.isInteger(protocolDeviceId) || protocolDeviceId < 1) throw new SessionBundleError();
  let identity: CompositeIdentityV1;
  try {
    identity = decodeCompositeIdentityV1(
      base64ToBytes(bundle.identityKey as Parameters<typeof base64ToBytes>[0]),
    );
  } catch {
    throw new SessionBundleError();
  }
  return {
    registrationId: registrationIdFromIdentity(bundle.identityKey),
    deviceId: protocolDeviceId,
    identity,
    ecSignedPreKey: {
      keyId: bundle.signedPrekey.keyId,
      publicKey: asPublicKey(bundle.signedPrekey.publicKey),
      signature: asSignature(bundle.signedPrekey.signature),
    },
    ecOneTimePreKey: bundle.oneTimePrekey
      ? {
          keyId: bundle.oneTimePrekey.keyId,
          publicKey: asPublicKey(bundle.oneTimePrekey.publicKey),
        }
      : null,
  };
}

export async function establishedSession(
  store: KeyValueStore,
  peerUserId: string,
): Promise<EstablishedSession | null> {
  const locator = locatorFor(await readSessionIndex(store), peerUserId);
  if (!locator) return null;
  return { peerUserId: locator.peerUserId, peerDeviceId: locator.peerDeviceId, created: false };
}

/**
 * Fetch one public bundle and run the SDK initiator handshake.
 * A session that already exists is reused, so a repeat call does not consume
 * another one-time prekey.
 */
export async function ensureSessionWithUser(input: EnsureSessionInput): Promise<EstablishedSession> {
  assertSecureStoreKey(input.localUserId);
  assertSecureStoreKey(input.peerUserId);
  const existing = await establishedSession(input.store, input.peerUserId);
  if (existing) return existing;

  let response: GetPrekeyBundleResponse;
  try {
    response = await input.getPrekeyBundle(input.sessionToken, input.peerUserId);
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    const detail =
      error instanceof Error && error.message ? error.message : "prekey fetch failed";
    if (status === 404 || detail.includes("no prekey bundle")) {
      throw new SessionBundleError(
        "That contact has not published encryption keys yet. Ask them to open Messages and wait until it says Keys ready, then try again.",
      );
    }
    if (status === 401) {
      throw new SessionBundleError("Session expired — sign in again on this device.");
    }
    throw new SessionBundleError(`Could not fetch their keys (${detail}).`);
  }
  if (response.userId !== input.peerUserId) throw new SessionBundleError();
  const picked = pickDeviceBundle(response.bundles);
  if (!picked) throw new SessionBundleError();
  assertSecureStoreKey(picked.deviceId);

  const opened = await openClient(input.store, input.localUserId);
  const protocolDeviceId = protocolDeviceIdFor(opened.index, input.peerUserId, picked.deviceId);
  const remote = ProtocolAddress.create(input.peerUserId, protocolDeviceId);
  const bundle = toSdkPreKeyBundle(picked, protocolDeviceId);
  await opened.signal.establishSession(remote, bundle);
  try {
    await opened.storage.saveContactIdentity(remote, bundle.identity, "aci");
  } catch {
    // The session state still carries the peer identity for the safety number.
  }
  await persistPeer(input.store, opened, {
    peerUserId: input.peerUserId,
    peerDeviceId: picked.deviceId,
    protocolDeviceId,
  });
  return { peerUserId: input.peerUserId, peerDeviceId: picked.deviceId, created: true };
}

/** Encrypt plaintext for an existing peer session. Returns an opaque envelope. */
export async function encryptForPeer(input: EncryptForPeerInput): Promise<OpaqueEnvelope> {
  assertSecureStoreKey(input.localUserId);
  assertSecureStoreKey(input.peerUserId);
  const opened = await openClient(input.store, input.localUserId);
  const locator = locatorFor(opened.index, input.peerUserId, input.peerDeviceId);
  if (!locator) throw new SessionNotEstablishedError();
  const remote = ProtocolAddress.create(locator.peerUserId, locator.protocolDeviceId);
  const ciphertext = await opened.signal.encryptMessage(remote, input.plaintext);
  const envelope: OpaqueEnvelope = {
    version: 1,
    senderUserId: input.localUserId,
    senderDeviceId: localDeviceId(opened.device),
    recipientUserId: locator.peerUserId,
    recipientDeviceId: locator.peerDeviceId,
    ciphertext,
  };
  assertOpaque(envelope, input.plaintext, await secretStrings(opened, remote));
  await persistPeer(input.store, opened, locator);
  return envelope;
}

/**
 * Decrypt an envelope. The first prekey message establishes the responder
 * session from the local device keys and saves it.
 */
export async function decryptFromPeer(input: DecryptFromPeerInput): Promise<string> {
  assertSecureStoreKey(input.localUserId);
  const envelope = readEnvelope(input.envelope);
  if (envelope.recipientUserId !== input.localUserId) throw new SessionMessageError();
  const opened = await openClient(input.store, input.localUserId);
  if (envelope.recipientDeviceId !== localDeviceId(opened.device)) throw new SessionMessageError();
  const protocolDeviceId = protocolDeviceIdFor(opened.index, envelope.senderUserId, envelope.senderDeviceId);
  const remote = ProtocolAddress.create(envelope.senderUserId, protocolDeviceId);
  let plaintext: string;
  try {
    plaintext = await opened.signal.decryptMessage(remote, envelope.ciphertext as Ciphertext);
  } catch {
    throw new SessionMessageError();
  }
  await persistPeer(input.store, opened, {
    peerUserId: envelope.senderUserId,
    peerDeviceId: envelope.senderDeviceId,
    protocolDeviceId,
  });
  return plaintext;
}

function localDeviceId(record: PersistedDeviceKeys): string {
  return record.serverDeviceId ?? "local";
}

async function loadDevice(store: KeyValueStore): Promise<PersistedDeviceKeys> {
  const raw = await store.getItem(DEVICE_KEY_RECORD_KEY);
  if (raw == null) throw new SessionKeysMissingError();
  return parseRecord(raw);
}

async function seed(storage: InMemorySignalProtocolStore, record: PersistedDeviceKeys): Promise<void> {
  await storage.storeIdentityKey(
    {
      registrationId: record.identity.registrationId,
      dhKey: {
        publicKey: asPublicKey(record.identity.dhPublicKey),
        privateKey: record.identity.dhPrivateKey as PrivateKey,
      },
      signingKey: {
        publicKey: asPublicKey(record.identity.signingPublicKey),
        privateKey: record.identity.signingPrivateKey as PrivateKey,
      },
    },
    "aci",
  );
  await storage.setLocalRegistrationId(record.identity.registrationId, "aci");
  await storage.storeEcSignedPreKey(
    {
      keyId: record.signedPreKey.keyId,
      publicKey: asPublicKey(record.signedPreKey.publicKey),
      privateKey: record.signedPreKey.privateKey as PrivateKey,
      signature: asSignature(record.signedPreKey.signature),
      timestamp: record.signedPreKey.timestamp,
    },
    "aci",
  );
  if (record.oneTimePreKeys.length > 0) {
    await storage.storeEcOneTimePreKeys(
      record.oneTimePreKeys.map((prekey) => ({
        keyId: prekey.keyId,
        publicKey: asPublicKey(prekey.publicKey),
        privateKey: prekey.privateKey as PrivateKey,
      })),
      "aci",
    );
  }
  await storage.storeKyberPreKey(
    {
      keyId: record.kyberPreKey.keyId,
      publicKey: asPublicKey(record.kyberPreKey.publicKey),
      privateKey: record.kyberPreKey.privateKey as PrivateKey,
      signature: asSignature(record.kyberPreKey.signature),
      timestamp: record.kyberPreKey.timestamp,
    },
    "aci",
  );
}

/** Rehydrate device keys and 1:1 sessions for one Signal client. */
export async function openSeededClient(store: KeyValueStore, localUserId: string): Promise<OpenedClient> {
  assertSecureStoreKey(localUserId);
  return openClient(store, localUserId);
}

async function openClient(store: KeyValueStore, localUserId: string): Promise<OpenedClient> {
  const device = await loadDevice(store);
  const storage = inMemoryStore();
  await seed(storage, device);
  let index = await readSessionIndex(store);
  for (const locator of index.sessions) {
    const saved = await readPeerSession(store, locator);
    if (!saved) continue;
    const address = ProtocolAddress.create(locator.peerUserId, locator.protocolDeviceId);
    try {
      await storage.storeSessionRecord(address, saved.record as SdkSessionRecord);
    } catch {
      throw new SessionRecordError();
    }
    if (saved.remoteIdentity) {
      await storage.saveContactIdentity(address, saved.remoteIdentity, "aci");
    }
  }
  const signal = await createSignalProtocolClient({
    identity: { userId: localUserId, deviceId: LOCAL_PROTOCOL_DEVICE_ID },
    adapters: { storage },
    protocol: { postQuantum: PostQuantumPolicy.Compatible },
    logger: SILENT_LOGGER,
  });
  index = await readSessionIndex(store);
  return { signal, storage, device, index };
}

function remoteIdentityOnSession(record: SdkSessionRecord): CompositeIdentityV1 | null {
  const remote = record.currentSession?.remoteIdentity;
  if (!remote || remote.version !== 1) return null;
  if (typeof remote.x25519PublicKey !== "string" || typeof remote.ed25519PublicKey !== "string") return null;
  return {
    version: 1,
    x25519PublicKey: remote.x25519PublicKey,
    ed25519PublicKey: remote.ed25519PublicKey,
  };
}

async function persistPeer(
  store: KeyValueStore,
  opened: OpenedClient,
  locator: SessionLocator,
): Promise<void> {
  const address = ProtocolAddress.create(locator.peerUserId, locator.protocolDeviceId);
  const record = await opened.storage.getSessionRecord(address);
  if (!record?.currentSession) throw new SessionRecordError();
  const contact = await opened.storage.getContactIdentity(address, "aci");
  opened.index = await writePeerSession(store, opened.index, {
    locator,
    record,
    remoteIdentity: contact?.identity ?? remoteIdentityOnSession(record),
  });
  await syncConsumedOneTimePreKeys(store, opened);
}

async function syncConsumedOneTimePreKeys(store: KeyValueStore, opened: OpenedClient): Promise<void> {
  const remaining = new Set(
    (await opened.storage.getEcOneTimePreKeys("aci")).map((prekey) => prekey.keyId),
  );
  if (opened.device.oneTimePreKeys.every((prekey) => remaining.has(prekey.keyId))) return;
  opened.device = {
    ...opened.device,
    oneTimePreKeys: opened.device.oneTimePreKeys.filter((prekey) => remaining.has(prekey.keyId)),
  };
  await store.setItem(DEVICE_KEY_RECORD_KEY, serializeRecord(opened.device));
}

function readEnvelope(value: OpaqueEnvelope): OpaqueEnvelope {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length < 8 ||
    typeof value.senderUserId !== "string" ||
    typeof value.senderDeviceId !== "string" ||
    typeof value.recipientUserId !== "string" ||
    typeof value.recipientDeviceId !== "string"
  ) {
    throw new SessionMessageError();
  }
  assertSecureStoreKey(value.senderUserId);
  assertSecureStoreKey(value.senderDeviceId);
  assertSecureStoreKey(value.recipientUserId);
  assertSecureStoreKey(value.recipientDeviceId);
  return value;
}

function ownKeys(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) ownKeys(item, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      ownKeys(child, found);
    }
  }
}

function privateStrings(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) privateStrings(item, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/private/i.test(key) && typeof child === "string" && child.length > 0) found.push(child);
    privateStrings(child, found);
  }
}

async function secretStrings(opened: OpenedClient, remote: ProtocolAddress): Promise<string[]> {
  const secrets = [...privateMaterial(opened.device)];
  privateStrings(await opened.storage.getSessionRecord(remote), secrets);
  return secrets;
}

function assertOpaque(envelope: OpaqueEnvelope, plaintext: string, secrets: readonly string[]): void {
  const names: string[] = [];
  ownKeys(envelope, names);
  if (names.some((name) => /private/i.test(name))) throw new SessionLeakError();
  const body = JSON.stringify(envelope);
  if (plaintext.length >= 12 && (envelope.ciphertext === plaintext || envelope.ciphertext.includes(plaintext))) {
    throw new SessionLeakError();
  }
  for (const secret of secrets) {
    if (secret.length > 0 && body.includes(secret)) throw new SessionLeakError();
  }
}
