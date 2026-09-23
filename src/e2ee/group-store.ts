import type { SenderKeyState } from "@open-e2ee/signal-protocol-sdk";
import type { InMemorySignalProtocolStore } from "@open-e2ee/signal-protocol-sdk/local/store/memory";
import { GroupKeyError } from "./errors";
import { assertSecureStoreKey, type KeyValueStore } from "./store";

export const SENDER_KEY_FILE = "encrypt.sender-keys";
export const GROUP_BOOK_KEY = "encrypt.groups.book";

export interface SenderKeyLocator {
  groupId: string;
  userId: string;
  deviceId: number;
}

interface SkippedSenderKey {
  groupId: string;
  userId: string;
  deviceId: number;
  chainIndex: number;
  cipherKey: string;
  iv: string;
}

interface SenderKeyFile {
  version: 1;
  records: (SenderKeyLocator & { states: SenderKeyState[] })[];
  skipped: SkippedSenderKey[];
}

export interface GroupDistributionBookEntry {
  groupId: string;
  senderKeyId: string;
  /** Peer user ids this device has already distributed `senderKeyId` to. */
  members: string[];
}

interface GroupBookFile {
  version: 1;
  groups: GroupDistributionBookEntry[];
}

type SkippedMap = Map<string, { cipherKey: string; iv: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyFile(): SenderKeyFile {
  return { version: 1, records: [], skipped: [] };
}

function locatorKey(locator: SenderKeyLocator): string {
  return `${locator.groupId}:${locator.userId}:${locator.deviceId}`;
}

function parseState(value: unknown): SenderKeyState {
  if (!isRecord(value)) throw new GroupKeyError();
  if (
    typeof value.senderKeyId !== "string" ||
    typeof value.senderKeyVersion !== "string" ||
    typeof value.chainKey !== "string" ||
    typeof value.signatureKey !== "string" ||
    typeof value.publicSignatureKey !== "string"
  ) {
    throw new GroupKeyError();
  }
  if (
    typeof value.chainId !== "number" ||
    typeof value.generation !== "number" ||
    typeof value.chainIndex !== "number" ||
    typeof value.createdAt !== "number"
  ) {
    throw new GroupKeyError();
  }
  const state: SenderKeyState = {
    senderKeyId: value.senderKeyId,
    senderKeyVersion: value.senderKeyVersion,
    chainId: value.chainId,
    generation: value.generation,
    chainKey: value.chainKey,
    signatureKey: value.signatureKey,
    publicSignatureKey: value.publicSignatureKey,
    chainIndex: value.chainIndex,
    createdAt: value.createdAt,
  };
  if (typeof value.distributionPending === "boolean") state.distributionPending = value.distributionPending;
  return state;
}

function parseLocator(value: unknown): SenderKeyLocator {
  if (!isRecord(value)) throw new GroupKeyError();
  if (typeof value.groupId !== "string" || typeof value.userId !== "string") throw new GroupKeyError();
  if (typeof value.deviceId !== "number" || !Number.isInteger(value.deviceId) || value.deviceId < 1) {
    throw new GroupKeyError();
  }
  return { groupId: value.groupId, userId: value.userId, deviceId: value.deviceId };
}

async function readFile(store: KeyValueStore): Promise<SenderKeyFile> {
  const raw = await store.getItem(SENDER_KEY_FILE);
  if (raw == null) return emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GroupKeyError();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.skipped)) {
    throw new GroupKeyError();
  }
  return {
    version: 1,
    records: parsed.records.map((entry) => {
      const locator = parseLocator(entry);
      if (!isRecord(entry) || !Array.isArray(entry.states) || entry.states.length === 0) throw new GroupKeyError();
      return { ...locator, states: entry.states.map(parseState) };
    }),
    skipped: parsed.skipped.map((entry) => {
      const locator = parseLocator(entry);
      if (!isRecord(entry) || typeof entry.chainIndex !== "number" || !Number.isInteger(entry.chainIndex)) {
        throw new GroupKeyError();
      }
      if (typeof entry.cipherKey !== "string" || typeof entry.iv !== "string") throw new GroupKeyError();
      return { ...locator, chainIndex: entry.chainIndex, cipherKey: entry.cipherKey, iv: entry.iv };
    }),
  };
}

/**
 * The in-memory adapter keeps out-of-order message keys on a map and does not
 * expose a list method. Copy that map into Secure Store with the sender-key record.
 */
function skippedMap(storage: InMemorySignalProtocolStore): SkippedMap | null {
  const map = (storage as unknown as { skippedSenderKeys?: SkippedMap }).skippedSenderKeys;
  return map instanceof Map ? map : null;
}

function parseSkippedId(key: string, messageKey: { cipherKey: string; iv: string }): SkippedSenderKey | null {
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const chainIndex = Number(parts.pop());
  const deviceId = Number(parts.pop());
  const userId = parts.pop();
  const groupId = parts.join(":");
  if (!userId || !groupId) return null;
  if (!Number.isInteger(deviceId) || deviceId < 1) return null;
  if (!Number.isInteger(chainIndex) || chainIndex < 0) return null;
  if (typeof messageKey?.cipherKey !== "string" || typeof messageKey.iv !== "string") return null;
  return { groupId, userId, deviceId, chainIndex, cipherKey: messageKey.cipherKey, iv: messageKey.iv };
}

/** Load sender-key records into a freshly opened in-memory client. */
export async function restoreSenderKeys(store: KeyValueStore, storage: InMemorySignalProtocolStore): Promise<void> {
  const file = await readFile(store);
  for (const record of file.records) {
    await storage.storeSenderKeyRecord(record.groupId, record.userId, record.deviceId, record.states);
  }
  for (const skipped of file.skipped) {
    await storage.storeSkippedSenderKey(skipped.groupId, skipped.userId, skipped.deviceId, skipped.chainIndex, {
      cipherKey: skipped.cipherKey,
      iv: skipped.iv,
    });
  }
}

/** Write the current chain, previous states, and skipped keys back to Secure Store. */
export async function persistSenderKeys(
  store: KeyValueStore,
  storage: InMemorySignalProtocolStore,
  extra: readonly SenderKeyLocator[],
): Promise<void> {
  const file = await readFile(store);
  const locators = new Map<string, SenderKeyLocator>();
  for (const record of file.records) locators.set(locatorKey(record), record);
  for (const locator of extra) locators.set(locatorKey(locator), locator);

  const records: SenderKeyFile["records"] = [];
  for (const locator of locators.values()) {
    const current = await storage.getSenderKey(locator.groupId, locator.userId, locator.deviceId);
    const record = await storage.getSenderKeyRecord(locator.groupId, locator.userId, locator.deviceId);
    // Encrypt advances the chain through `storeSenderKey` only. The record list
    // can still hold the pre-encrypt state, so the live key has to lead the file.
    const previous = (record ?? []).filter((state) => !current || state.senderKeyId !== current.senderKeyId);
    const states = current ? [current, ...previous] : (record ?? []);
    if (states.length === 0) continue;
    records.push({ ...locator, states: states.map(parseState) });
  }

  const liveSkipped = skippedMap(storage);
  const skipped = liveSkipped
    ? [...liveSkipped.entries()].flatMap(([key, messageKey]) => {
        const parsed = parseSkippedId(key, messageKey);
        return parsed ? [parsed] : [];
      })
    : file.skipped;

  const next: SenderKeyFile = { version: 1, records, skipped };
  await store.setItem(SENDER_KEY_FILE, JSON.stringify(next));
}

export async function readGroupBook(store: KeyValueStore, groupId: string): Promise<GroupDistributionBookEntry | null> {
  assertSecureStoreKey(GROUP_BOOK_KEY);
  const raw = await store.getItem(GROUP_BOOK_KEY);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GroupKeyError();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.groups)) throw new GroupKeyError();
  const entry = parsed.groups.find((item) => isRecord(item) && item.groupId === groupId);
  if (!entry || !isRecord(entry)) return null;
  if (typeof entry.senderKeyId !== "string" || !Array.isArray(entry.members)) throw new GroupKeyError();
  if (!entry.members.every((member) => typeof member === "string")) throw new GroupKeyError();
  return { groupId, senderKeyId: entry.senderKeyId, members: entry.members };
}

export async function writeGroupBook(store: KeyValueStore, entry: GroupDistributionBookEntry): Promise<void> {
  assertSecureStoreKey(GROUP_BOOK_KEY);
  const raw = await store.getItem(GROUP_BOOK_KEY);
  let file: GroupBookFile = { version: 1, groups: [] };
  if (raw != null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new GroupKeyError();
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.groups)) throw new GroupKeyError();
    file = {
      version: 1,
      groups: parsed.groups.filter((item) => isRecord(item) && item.groupId !== entry.groupId) as GroupBookFile["groups"],
    };
  }
  file.groups.push({
    groupId: entry.groupId,
    senderKeyId: entry.senderKeyId,
    members: [...entry.members].sort(),
  });
  await store.setItem(GROUP_BOOK_KEY, JSON.stringify(file));
}
