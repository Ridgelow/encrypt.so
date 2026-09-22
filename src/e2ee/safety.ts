import { base64ToBytes } from "@open-e2ee/signal-protocol-sdk/encoding";
import { decodeCompositeIdentityV1, type CompositeIdentityV1 } from "@open-e2ee/signal-protocol-sdk/keys";
import { compareSafetyNumbers, generateCompositeSafetyNumber } from "@open-e2ee/signal-protocol-sdk/safety";
import { SessionKeysMissingError, SessionNotEstablishedError } from "./errors";
import { DEVICE_KEY_RECORD_KEY, parseRecord } from "./record";
import { locatorFor, readPeerSession, readSessionIndex } from "./session-store";
import { assertSecureStoreKey, type KeyValueStore } from "./store";

export const VERIFIED_PEERS_KEY = "encrypt.safety.verified";

/** Twelve groups of five digits, from the SDK composite safety number. */
export interface SafetyFingerprint {
  /** Spaced 60-digit number from `generateCompositeSafetyNumber`. */
  numeric: string;
  groups: string[];
  /** Digits only. This is what verification is pinned to. */
  digits: string;
  hex: string;
}

export interface VerifiedPeer {
  peerUserId: string;
  fingerprint: string;
  verifiedAt: number;
}

interface VerifiedFile {
  version: 1;
  peers: VerifiedPeer[];
}

function canonicalIdentity(identity: CompositeIdentityV1): CompositeIdentityV1 {
  return {
    version: 1,
    x25519PublicKey: identity.x25519PublicKey,
    ed25519PublicKey: identity.ed25519PublicKey,
  };
}

function identityFromUnknown(value: unknown): CompositeIdentityV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (typeof record.x25519PublicKey !== "string" || typeof record.ed25519PublicKey !== "string") return null;
  return canonicalIdentity({
    version: 1,
    x25519PublicKey: record.x25519PublicKey as CompositeIdentityV1["x25519PublicKey"],
    ed25519PublicKey: record.ed25519PublicKey as CompositeIdentityV1["ed25519PublicKey"],
  });
}

/** Peer composite identity saved with the session, or the one bound into the session state. */
export function remoteIdentityFromSessionRecord(record: unknown): CompositeIdentityV1 | null {
  if (typeof record !== "object" || record === null) return null;
  const current = (record as { currentSession?: unknown }).currentSession;
  if (typeof current !== "object" || current === null) return null;
  return identityFromUnknown((current as { remoteIdentity?: unknown }).remoteIdentity);
}

/**
 * Stable safety number for one pair of composite identities.
 * Uses the SDK's composite fingerprint. The same pair matches from either side.
 */
export function safetyNumberFromIdentities(
  localIdentity: CompositeIdentityV1,
  remoteIdentity: CompositeIdentityV1,
  localUserId: string,
  remoteUserId: string,
): SafetyFingerprint {
  const generated = generateCompositeSafetyNumber(
    canonicalIdentity(localIdentity),
    canonicalIdentity(remoteIdentity),
    localUserId,
    remoteUserId,
  );
  const digits = generated.numeric.replace(/\D/g, "");
  const groups = generated.numeric.split(/\s+/).filter((group) => group.length > 0);
  return { numeric: generated.numeric, groups, digits, hex: generated.hex };
}

export function fingerprintsMatch(a: string, b: string): boolean {
  return compareSafetyNumbers(a, b);
}

/**
 * Safety number for a peer that already has a session on this device.
 * Identity material comes from the local device record and the stored peer session.
 */
export async function safetyNumberForPeer(input: {
  store: KeyValueStore;
  localUserId: string;
  peerUserId: string;
}): Promise<SafetyFingerprint> {
  assertSecureStoreKey(input.localUserId);
  assertSecureStoreKey(input.peerUserId);
  const raw = await input.store.getItem(DEVICE_KEY_RECORD_KEY);
  if (raw == null) throw new SessionKeysMissingError();
  const device = parseRecord(raw);
  let local: CompositeIdentityV1;
  try {
    local = decodeCompositeIdentityV1(
      base64ToBytes(device.identity.identityPublic as Parameters<typeof base64ToBytes>[0]),
    );
  } catch {
    throw new SessionKeysMissingError();
  }

  const locator = locatorFor(await readSessionIndex(input.store), input.peerUserId);
  if (!locator) throw new SessionNotEstablishedError();
  const saved = await readPeerSession(input.store, locator);
  const remote = saved?.remoteIdentity ?? remoteIdentityFromSessionRecord(saved?.record);
  if (!remote) throw new SessionNotEstablishedError();
  return safetyNumberFromIdentities(local, remote, input.localUserId, input.peerUserId);
}

function isVerifiedPeer(value: unknown): value is VerifiedPeer {
  if (typeof value !== "object" || value === null) return false;
  const peer = value as VerifiedPeer;
  return (
    typeof peer.peerUserId === "string" &&
    typeof peer.fingerprint === "string" &&
    /^\d{60}$/.test(peer.fingerprint) &&
    typeof peer.verifiedAt === "number"
  );
}

async function readVerifiedFile(store: KeyValueStore): Promise<VerifiedFile> {
  const raw = await store.getItem(VERIFIED_PEERS_KEY);
  if (!raw) return { version: 1, peers: [] };
  try {
    const parsed = JSON.parse(raw) as VerifiedFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.peers)) return { version: 1, peers: [] };
    return { version: 1, peers: parsed.peers.filter(isVerifiedPeer) };
  } catch {
    return { version: 1, peers: [] };
  }
}

export async function readPeerVerification(store: KeyValueStore, peerUserId: string): Promise<VerifiedPeer | null> {
  assertSecureStoreKey(peerUserId);
  const file = await readVerifiedFile(store);
  return file.peers.find((peer) => peer.peerUserId === peerUserId) ?? null;
}

/** True only when the stored decision is for this exact fingerprint. */
export function verificationMatches(saved: VerifiedPeer | null, fingerprint: SafetyFingerprint): boolean {
  if (!saved) return false;
  return fingerprintsMatch(saved.fingerprint, fingerprint.digits);
}

/**
 * Record or clear a verification decision for this peer.
 * The decision is pinned to the fingerprint the user compared.
 */
export async function setPeerVerified(
  store: KeyValueStore,
  peerUserId: string,
  fingerprint: string,
  verified: boolean,
  verifiedAt = Date.now(),
): Promise<void> {
  assertSecureStoreKey(peerUserId);
  const digits = fingerprint.replace(/\D/g, "");
  if (verified && !/^\d{60}$/.test(digits)) {
    throw new Error("Safety number is not comparable.");
  }
  const file = await readVerifiedFile(store);
  const peers = file.peers.filter((peer) => peer.peerUserId !== peerUserId);
  if (verified) {
    peers.push({ peerUserId, fingerprint: digits, verifiedAt });
  }
  if (peers.length === 0) {
    await store.deleteItem(VERIFIED_PEERS_KEY);
    return;
  }
  await store.setItem(VERIFIED_PEERS_KEY, JSON.stringify({ version: 1, peers }));
}
