import { bytesToBase64, base64ToBytes } from "@open-e2ee/signal-protocol-sdk/encoding";
import type { SenderKeyDistributionMessage } from "@open-e2ee/signal-protocol-sdk";
import { GroupKeyError, GroupMessageError, SessionLeakError } from "./errors";
import {
  persistSenderKeys,
  readGroupBook,
  restoreSenderKeys,
  writeGroupBook,
  type SenderKeyLocator,
} from "./group-store";
import {
  decodeGroupSender,
  encodeGroupDistribution,
  encodeGroupSender,
  type GroupSenderPayload,
} from "./group-wire";
import {
  decryptFromPeer,
  encryptForPeer,
  isPeerUserId,
  LOCAL_PROTOCOL_DEVICE_ID,
  openSeededClient,
  type OpaqueEnvelope,
  type OpenedClient,
} from "./session";
import type { KeyValueStore } from "./store";

export interface PreparedDistributions {
  senderKeyId: string;
  envelopes: OpaqueEnvelope[];
}

export interface GroupCiphertext {
  /** Opaque worker ciphertext. The same bytes go to every member. */
  ciphertext: string;
  senderDeviceId: string;
  payload: GroupSenderPayload;
}

interface GroupClientInput {
  store: KeyValueStore;
  localUserId: string;
  groupId: string;
}

function peersOf(localUserId: string, memberUserIds: readonly string[]): string[] {
  const peers = [...new Set(memberUserIds.filter((id) => id !== localUserId))].sort();
  for (const peer of peers) {
    if (!isPeerUserId(peer)) throw new GroupKeyError();
  }
  return peers;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

function ownLocator(groupId: string, localUserId: string): SenderKeyLocator {
  return { groupId, userId: localUserId, deviceId: LOCAL_PROTOCOL_DEVICE_ID };
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

function assertNoLeak(value: unknown, secrets: readonly string[], plaintext?: string): void {
  if (fieldNames(value).some((name) => /private/i.test(name))) throw new SessionLeakError();
  const body = JSON.stringify(value);
  if (plaintext && plaintext.length >= 12 && body.includes(plaintext)) throw new SessionLeakError();
  for (const secret of secrets) {
    if (secret.length > 0 && body.includes(secret)) throw new SessionLeakError();
  }
}

function readDistribution(value: unknown): SenderKeyDistributionMessage {
  if (typeof value !== "object" || value === null) throw new GroupMessageError();
  const record = value as Record<string, unknown>;
  if (
    typeof record.senderKeyId !== "string" ||
    typeof record.chainKey !== "string" ||
    typeof record.publicSignatureKey !== "string" ||
    typeof record.chainId !== "number" ||
    typeof record.generation !== "number" ||
    typeof record.chainIndex !== "number"
  ) {
    throw new GroupMessageError();
  }
  if (fieldNames(record).some((name) => /private/i.test(name))) throw new SessionLeakError();
  return {
    senderKeyId: record.senderKeyId,
    chainId: record.chainId,
    generation: record.generation,
    chainIndex: record.chainIndex,
    chainKey: record.chainKey,
    publicSignatureKey: record.publicSignatureKey,
  };
}

async function withSenderKeys<T>(
  store: KeyValueStore,
  localUserId: string,
  run: (opened: OpenedClient, touch: (locator: SenderKeyLocator) => void) => Promise<T>,
): Promise<T> {
  const opened = await openSeededClient(store, localUserId);
  await restoreSenderKeys(store, opened.storage);
  const touched: SenderKeyLocator[] = [];
  const result = await run(opened, (locator) => {
    touched.push(locator);
  });
  await persistSenderKeys(store, opened.storage, touched);
  return result;
}

async function signingSecret(opened: OpenedClient, groupId: string, localUserId: string): Promise<string> {
  const states = await opened.storage.getSenderKeyRecord(groupId, localUserId, LOCAL_PROTOCOL_DEVICE_ID);
  const secret = states?.[0]?.signatureKey;
  return typeof secret === "string" ? secret : "";
}

/**
 * Create or rotate this device's sender key, then seal one 1:1 distribution
 * envelope per peer. The caller posts those envelopes, then commits the book.
 * A membership change rotates before the new envelopes are built.
 */
export async function prepareGroupDistributions(input: GroupClientInput & {
  memberUserIds: readonly string[];
}): Promise<PreparedDistributions> {
  if (!isPeerUserId(input.groupId) || !isPeerUserId(input.localUserId)) throw new GroupKeyError();
  const peers = peersOf(input.localUserId, input.memberUserIds);
  if (peers.length < 1) throw new GroupKeyError();
  const book = await readGroupBook(input.store, input.groupId);
  const locator = ownLocator(input.groupId, input.localUserId);

  const { distribution, signatureKey } = await withSenderKeys(input.store, input.localUserId, async (opened, touch) => {
    let current = await opened.signal.getGroupSenderKeyDistribution(input.groupId);
    if (!current) {
      current = (await opened.signal.createGroupSenderKey(input.groupId)).distributionMessage;
    } else if (book && !sameMembers(book.members, peers) && book.senderKeyId === current.senderKeyId) {
      current = (await opened.signal.rotateGroupSenderKey(input.groupId)).distributionMessage;
    }
    touch(locator);
    const secret = await signingSecret(opened, input.groupId, input.localUserId);
    return { distribution: readDistribution(current), signatureKey: secret };
  });

  if (book && book.senderKeyId === distribution.senderKeyId && sameMembers(book.members, peers)) {
    return { senderKeyId: distribution.senderKeyId, envelopes: [] };
  }

  const plaintext = JSON.stringify(distribution);
  const envelopes: OpaqueEnvelope[] = [];
  for (const peerUserId of peers) {
    const envelope = await encryptForPeer({
      store: input.store,
      localUserId: input.localUserId,
      peerUserId,
      plaintext,
    });
    assertNoLeak(envelope, [distribution.chainKey, signatureKey, plaintext], plaintext);
    envelopes.push(envelope);
  }
  return { senderKeyId: distribution.senderKeyId, envelopes };
}

/** Record that `senderKeyId` was distributed to these peers. */
export async function commitGroupDistribution(input: GroupClientInput & {
  senderKeyId: string;
  memberUserIds: readonly string[];
}): Promise<void> {
  if (!isPeerUserId(input.groupId)) throw new GroupKeyError();
  const peers = peersOf(input.localUserId, input.memberUserIds);
  await writeGroupBook(input.store, { groupId: input.groupId, senderKeyId: input.senderKeyId, members: peers });
}

/**
 * Decrypt a pairwise distribution envelope and store that member's sender key.
 * A repeat of the same distribution is ignored once the key is already stored.
 */
export async function acceptGroupDistribution(input: GroupClientInput & {
  protocolDeviceId: number;
  envelope: OpaqueEnvelope;
}): Promise<void> {
  if (!isPeerUserId(input.groupId)) throw new GroupKeyError();
  if (!Number.isInteger(input.protocolDeviceId) || input.protocolDeviceId < 1) throw new GroupMessageError();
  const senderUserId = input.envelope.senderUserId;
  if (!isPeerUserId(senderUserId) || senderUserId === input.localUserId) throw new GroupMessageError();
  const locator = { groupId: input.groupId, userId: senderUserId, deviceId: input.protocolDeviceId };
  let distribution: SenderKeyDistributionMessage;
  try {
    distribution = readDistribution(JSON.parse(await decryptFromPeer({
      store: input.store,
      localUserId: input.localUserId,
      envelope: input.envelope,
    })) as unknown);
  } catch (err) {
    if (err instanceof SessionLeakError) throw err;
    if (await senderKeyExists(input.store, input.localUserId, locator)) return;
    throw new GroupMessageError();
  }
  try {
    await withSenderKeys(input.store, input.localUserId, async (opened, touch) => {
      await opened.signal.processGroupSenderKeyDistribution(
        input.groupId,
        senderUserId,
        input.protocolDeviceId,
        distribution,
      );
      touch(locator);
    });
  } catch (err) {
    if (err instanceof SessionLeakError) throw err;
    if (await senderKeyExists(input.store, input.localUserId, locator)) return;
    throw new GroupMessageError();
  }
}

async function senderKeyExists(
  store: KeyValueStore,
  localUserId: string,
  locator: SenderKeyLocator,
): Promise<boolean> {
  const opened = await openSeededClient(store, localUserId);
  await restoreSenderKeys(store, opened.storage);
  const existing = await opened.storage.getSenderKey(locator.groupId, locator.userId, locator.deviceId);
  return existing != null;
}

/** Encrypt plaintext once. Every member who holds this sender key can open the same ciphertext. */
export async function encryptGroupPlaintext(input: GroupClientInput & { plaintext: string }): Promise<GroupCiphertext> {
  if (!isPeerUserId(input.groupId)) throw new GroupKeyError();
  if (input.plaintext.length === 0) throw new GroupMessageError();
  const locator = ownLocator(input.groupId, input.localUserId);
  const sealed = await withSenderKeys(input.store, input.localUserId, async (opened, touch) => {
    const has = await opened.signal.hasGroupSenderKey(input.groupId);
    if (!has) throw new GroupKeyError();
    let frame: Uint8Array;
    try {
      frame = await opened.signal.encryptGroupMessage(input.groupId, input.plaintext);
    } catch {
      throw new GroupMessageError();
    }
    touch(locator);
    const states = await opened.storage.getSenderKeyRecord(input.groupId, input.localUserId, LOCAL_PROTOCOL_DEVICE_ID);
    const current = states?.[0];
    return {
      frame,
      senderDeviceId: opened.device.serverDeviceId ?? "local",
      secrets: [current?.chainKey ?? "", current?.signatureKey ?? ""].filter((secret) => secret.length > 0),
    };
  });
  const payload: GroupSenderPayload = {
    version: 1,
    kind: "sender-key",
    groupId: input.groupId,
    senderUserId: input.localUserId,
    protocolDeviceId: LOCAL_PROTOCOL_DEVICE_ID,
    frame: bytesToBase64(sealed.frame),
  };
  assertNoLeak(payload, sealed.secrets, input.plaintext);
  const frameText = new TextDecoder().decode(sealed.frame);
  if (input.plaintext.length >= 12 && frameText.includes(input.plaintext)) throw new SessionLeakError();
  for (const secret of sealed.secrets) {
    if (frameText.includes(secret)) throw new SessionLeakError();
  }
  return {
    ciphertext: encodeGroupSender(payload),
    senderDeviceId: sealed.senderDeviceId,
    payload,
  };
}

/** Open a sender-key frame addressed by the sender's user id and protocol device id. */
export async function decryptGroupPlaintext(input: {
  store: KeyValueStore;
  localUserId: string;
  ciphertext: string;
}): Promise<string> {
  const payload = decodeGroupSender(input.ciphertext);
  if (!isPeerUserId(payload.groupId) || !isPeerUserId(payload.senderUserId)) throw new GroupMessageError();
  if (payload.senderUserId === input.localUserId) throw new GroupMessageError();
  let frame: Uint8Array;
  try {
    frame = base64ToBytes(payload.frame as Parameters<typeof base64ToBytes>[0]);
  } catch {
    throw new GroupMessageError();
  }
  const locator = { groupId: payload.groupId, userId: payload.senderUserId, deviceId: payload.protocolDeviceId };
  try {
    return await withSenderKeys(input.store, input.localUserId, async (opened, touch) => {
      const plaintext = await opened.signal.decryptGroupMessage(
        payload.groupId,
        payload.senderUserId,
        payload.protocolDeviceId,
        frame,
      );
      touch(locator);
      return plaintext;
    });
  } catch (err) {
    if (err instanceof SessionLeakError || err instanceof GroupMessageError) throw err;
    throw new GroupMessageError();
  }
}

/** Wrap a pairwise distribution envelope for the group conversation. */
export function distributionCiphertext(groupId: string, protocolDeviceId: number, envelope: OpaqueEnvelope): string {
  const ciphertext = encodeGroupDistribution({
    version: 1,
    kind: "sender-key-distribution",
    groupId,
    protocolDeviceId,
    envelope,
  });
  assertNoLeak({ ciphertext }, [], undefined);
  return ciphertext;
}
