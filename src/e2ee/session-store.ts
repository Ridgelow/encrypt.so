import type { CompositeIdentityV1 } from "@open-e2ee/signal-protocol-sdk/keys";
import { SessionRecordError } from "./errors";
import { deserializeSessionRecord, serializeSessionRecord } from "./session-codec";
import { assertSecureStoreKey, type KeyValueStore } from "./store";

export const SESSION_INDEX_KEY = "encrypt.sessions.index";

export interface SessionLocator {
  peerUserId: string;
  peerDeviceId: string;
  protocolDeviceId: number;
}

interface SessionIndex {
  version: 1;
  sessions: SessionLocator[];
}

export interface StoredPeerSession {
  locator: SessionLocator;
  /** SDK session record, already validated by the store on the way in. */
  record: unknown;
  remoteIdentity: CompositeIdentityV1 | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionKey(peerUserId: string, peerDeviceId: string): string {
  assertSecureStoreKey(peerUserId);
  assertSecureStoreKey(peerDeviceId);
  const key = `encrypt.sess.${peerUserId}.${peerDeviceId}`;
  assertSecureStoreKey(key);
  return key;
}

function parseLocator(value: unknown): SessionLocator {
  if (!isRecord(value)) throw new SessionRecordError();
  if (typeof value.peerUserId !== "string" || typeof value.peerDeviceId !== "string") {
    throw new SessionRecordError();
  }
  if (typeof value.protocolDeviceId !== "number" || !Number.isInteger(value.protocolDeviceId)) {
    throw new SessionRecordError();
  }
  if (value.protocolDeviceId < 1) throw new SessionRecordError();
  assertSecureStoreKey(value.peerUserId);
  assertSecureStoreKey(value.peerDeviceId);
  return {
    peerUserId: value.peerUserId,
    peerDeviceId: value.peerDeviceId,
    protocolDeviceId: value.protocolDeviceId,
  };
}

function parseIdentity(value: unknown): CompositeIdentityV1 | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1) throw new SessionRecordError();
  if (typeof value.x25519PublicKey !== "string" || typeof value.ed25519PublicKey !== "string") {
    throw new SessionRecordError();
  }
  return {
    version: 1,
    x25519PublicKey: value.x25519PublicKey as CompositeIdentityV1["x25519PublicKey"],
    ed25519PublicKey: value.ed25519PublicKey as CompositeIdentityV1["ed25519PublicKey"],
  };
}

export async function readSessionIndex(store: KeyValueStore): Promise<SessionIndex> {
  const raw = await store.getItem(SESSION_INDEX_KEY);
  if (raw == null) return { version: 1, sessions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRecordError();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new SessionRecordError();
  }
  return { version: 1, sessions: parsed.sessions.map(parseLocator) };
}

async function writeSessionIndex(store: KeyValueStore, index: SessionIndex): Promise<void> {
  await store.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
}

export function locatorFor(
  index: SessionIndex,
  peerUserId: string,
  peerDeviceId?: string,
): SessionLocator | null {
  if (peerDeviceId) {
    return (
      index.sessions.find(
        (session) => session.peerUserId === peerUserId && session.peerDeviceId === peerDeviceId,
      ) ?? null
    );
  }
  return index.sessions.find((session) => session.peerUserId === peerUserId) ?? null;
}

/** Next protocol device id for this peer, stable once stored. */
export function protocolDeviceIdFor(
  index: SessionIndex,
  peerUserId: string,
  peerDeviceId: string,
): number {
  const existing = locatorFor(index, peerUserId, peerDeviceId);
  if (existing) return existing.protocolDeviceId;
  const used = new Set(
    index.sessions.filter((session) => session.peerUserId === peerUserId).map((session) => session.protocolDeviceId),
  );
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

export async function readPeerSession(
  store: KeyValueStore,
  locator: SessionLocator,
): Promise<StoredPeerSession | null> {
  const raw = await store.getItem(sessionKey(locator.peerUserId, locator.peerDeviceId));
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRecordError();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.session !== "string") {
    throw new SessionRecordError();
  }
  return {
    locator,
    record: deserializeSessionRecord(parsed.session),
    remoteIdentity: parseIdentity(parsed.remoteIdentity),
  };
}

export async function writePeerSession(
  store: KeyValueStore,
  index: SessionIndex,
  saved: StoredPeerSession,
): Promise<SessionIndex> {
  const locator = saved.locator;
  const next = locatorFor(index, locator.peerUserId, locator.peerDeviceId)
    ? {
        version: 1 as const,
        sessions: index.sessions.map((session) =>
          session.peerUserId === locator.peerUserId && session.peerDeviceId === locator.peerDeviceId
            ? locator
            : session,
        ),
      }
    : { version: 1 as const, sessions: [...index.sessions, locator] };

  await store.setItem(
    sessionKey(locator.peerUserId, locator.peerDeviceId),
    JSON.stringify({
      version: 1,
      peerUserId: locator.peerUserId,
      peerDeviceId: locator.peerDeviceId,
      protocolDeviceId: locator.protocolDeviceId,
      session: serializeSessionRecord(saved.record),
      remoteIdentity: saved.remoteIdentity,
    }),
  );
  await writeSessionIndex(store, next);
  return next;
}
