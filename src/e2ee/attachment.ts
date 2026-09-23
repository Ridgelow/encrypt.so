import { AttachmentError } from "./errors";
import { decodeOpaqueEnvelope, encodeOpaqueEnvelope } from "./envelope";
import type { OpaqueEnvelope } from "./session";
import { fillRandom, newClientId } from "@/lib/id";

/**
 * File bytes are encrypted with a fresh AES-256-GCM content key on device.
 * The SDK does not export Double Ratchet message keys, so the content key is
 * not derived from session state. `encryptForPeer` seals a small JSON
 * envelope (object key, size, mime, optional filename, content key, nonce).
 * That Signal envelope is the message ciphertext (`attachment/v1`). R2 receives
 * only the AES-GCM ciphertext. The content key is never returned from here
 * and must not be logged.
 */

export const ATTACHMENT_CONTENT_TYPE = "attachment/v1";
/** Matches the worker ciphertext cap. AES-GCM appends a 16-byte tag. */
export const ATTACHMENT_MAX_CIPHERTEXT = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_PLAINTEXT = ATTACHMENT_MAX_CIPHERTEXT - 16;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;

export type AttachmentUploadGrant = {
  objectKey: string;
  uploadUrl: string;
};

export type AttachmentPostBody = {
  ciphertext: string;
  contentType: typeof ATTACHMENT_CONTENT_TYPE;
  clientId: string;
  senderDeviceId?: string;
};

export type OpenedAttachment = {
  bytes: Uint8Array;
  mime: string;
  name?: string;
  objectKey: string;
};

type Descriptor = {
  v: 1;
  objectKey: string;
  byteLength: number;
  mime: string;
  name?: string;
  key: Uint8Array;
  nonce: Uint8Array;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j] ?? 0);
    binary += part;
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function cleanMime(mime: string | undefined): string {
  const value = (mime ?? "").trim().toLowerCase();
  return MIME.test(value) ? value : "application/octet-stream";
}

function cleanName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
  return cleaned;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

async function loadNativeAes() {
  if (nativeAes.ready) return;
  const mod = await import("expo-crypto");
  nativeAes.AESEncryptionKey = mod.AESEncryptionKey;
  nativeAes.AESSealedData = mod.AESSealedData;
  nativeAes.aesDecryptAsync = mod.aesDecryptAsync;
  nativeAes.aesEncryptAsync = mod.aesEncryptAsync;
  nativeAes.ready = true;
}

const nativeAes: {
  ready?: boolean;
  AESEncryptionKey?: typeof import("expo-crypto").AESEncryptionKey;
  AESSealedData?: typeof import("expo-crypto").AESSealedData;
  aesEncryptAsync?: typeof import("expo-crypto").aesEncryptAsync;
  aesDecryptAsync?: typeof import("expo-crypto").aesDecryptAsync;
} = {};

async function aesEncrypt(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const cryptoKey = await subtle.importKey("raw", bufferOf(key), { name: "AES-GCM" }, false, ["encrypt"]);
    const encrypted = await subtle.encrypt(
      { name: "AES-GCM", iv: bufferOf(nonce), additionalData: bufferOf(aad) },
      cryptoKey,
      bufferOf(plain),
    );
    return new Uint8Array(encrypted);
  }
  await loadNativeAes();
  const encryptionKey = await nativeAes.AESEncryptionKey!.import(key);
  const sealed = await nativeAes.aesEncryptAsync!(plain, encryptionKey, {
    additionalData: aad,
    nonce: { bytes: nonce },
  });
  return (await sealed.ciphertext({ includeTag: true, encoding: "bytes" })) as Uint8Array;
}

async function aesDecrypt(key: Uint8Array, nonce: Uint8Array, cipher: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const cryptoKey = await subtle.importKey("raw", bufferOf(key), { name: "AES-GCM" }, false, ["decrypt"]);
    try {
      const plain = await subtle.decrypt(
        { name: "AES-GCM", iv: bufferOf(nonce), additionalData: bufferOf(aad) },
        cryptoKey,
        bufferOf(cipher),
      );
      return new Uint8Array(plain);
    } catch {
      throw new AttachmentError();
    }
  }
  await loadNativeAes();
  try {
    const encryptionKey = await nativeAes.AESEncryptionKey!.import(key);
    const sealed = nativeAes.AESSealedData!.fromParts(nonce, cipher, 16);
    const plain = await nativeAes.aesDecryptAsync!(sealed, encryptionKey, {
      additionalData: aad,
      output: "bytes",
    });
    return plain instanceof Uint8Array ? plain : new Uint8Array();
  } catch {
    throw new AttachmentError();
  }
}

function readDescriptor(plaintext: string): Descriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new AttachmentError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AttachmentError();
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["v", "objectKey", "byteLength", "mime", "name", "key", "nonce"]);
  if (Object.keys(record).some((key) => !allowed.has(key) || /private/i.test(key))) throw new AttachmentError();
  if (record.v !== 1) throw new AttachmentError();
  if (typeof record.objectKey !== "string" || !UUID.test(record.objectKey)) throw new AttachmentError();
  if (typeof record.byteLength !== "number" || !Number.isInteger(record.byteLength) || record.byteLength < 1) {
    throw new AttachmentError();
  }
  if (typeof record.mime !== "string" || !MIME.test(record.mime)) throw new AttachmentError();
  if (record.name != null && (typeof record.name !== "string" || record.name.length > 120)) throw new AttachmentError();
  if (typeof record.key !== "string" || typeof record.nonce !== "string") throw new AttachmentError();

  let key: Uint8Array;
  let nonce: Uint8Array;
  try {
    key = base64ToBytes(record.key);
    nonce = base64ToBytes(record.nonce);
  } catch {
    throw new AttachmentError();
  }
  if (key.byteLength !== KEY_BYTES || nonce.byteLength !== NONCE_BYTES) {
    wipe(key);
    wipe(nonce);
    throw new AttachmentError();
  }
  return {
    v: 1,
    objectKey: record.objectKey,
    byteLength: record.byteLength,
    mime: record.mime,
    name: typeof record.name === "string" ? record.name : undefined,
    key,
    nonce,
  };
}

export async function sealAttachment(input: {
  bytes: Uint8Array;
  mime?: string;
  name?: string;
  objectKey: string;
  encrypt: (plaintext: string) => Promise<OpaqueEnvelope>;
}): Promise<{ envelope: OpaqueEnvelope; ciphertextBytes: Uint8Array; messageCiphertext: string }> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > ATTACHMENT_MAX_PLAINTEXT) throw new AttachmentError();
  if (!UUID.test(input.objectKey)) throw new AttachmentError();

  const key = fillRandom(new Uint8Array(KEY_BYTES));
  const nonce = fillRandom(new Uint8Array(NONCE_BYTES));
  const mime = cleanMime(input.mime);
  const name = cleanName(input.name);
  let ciphertextBytes: Uint8Array;
  try {
    ciphertextBytes = await aesEncrypt(key, nonce, input.bytes, new TextEncoder().encode(input.objectKey));
  } catch (error) {
    wipe(key);
    wipe(nonce);
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError();
  }

  const descriptor: Record<string, unknown> = {
    v: 1,
    objectKey: input.objectKey,
    byteLength: ciphertextBytes.byteLength,
    mime,
    key: bytesToBase64(key),
    nonce: bytesToBase64(nonce),
  };
  if (name) descriptor.name = name;
  const plaintext = JSON.stringify(descriptor);
  wipe(key);
  wipe(nonce);

  const envelope = await input.encrypt(plaintext);
  return {
    envelope,
    ciphertextBytes,
    messageCiphertext: encodeOpaqueEnvelope(envelope),
  };
}

export async function openAttachment(input: { plaintext: string; ciphertextBytes: Uint8Array }): Promise<OpenedAttachment> {
  const descriptor = readDescriptor(input.plaintext);
  try {
    if (input.ciphertextBytes.byteLength !== descriptor.byteLength) throw new AttachmentError();
    const bytes = await aesDecrypt(
      descriptor.key,
      descriptor.nonce,
      input.ciphertextBytes,
      new TextEncoder().encode(descriptor.objectKey),
    );
    return {
      bytes,
      mime: descriptor.mime,
      name: descriptor.name,
      objectKey: descriptor.objectKey,
    };
  } finally {
    wipe(descriptor.key);
    wipe(descriptor.nonce);
  }
}

/**
 * Mint an object key, seal the file, upload ciphertext, then post the Signal
 * envelope. `post` must send only the returned message fields.
 */
export async function deliverSealedAttachment(input: {
  bytes: Uint8Array;
  mime?: string;
  name?: string;
  clientId?: string;
  encrypt: (plaintext: string) => Promise<OpaqueEnvelope>;
  mint: () => Promise<AttachmentUploadGrant>;
  upload: (uploadUrl: string, ciphertext: Uint8Array) => Promise<void>;
  post: (body: AttachmentPostBody) => Promise<void>;
}): Promise<{ objectKey: string; messageCiphertext: string; clientId: string; senderDeviceId?: string }> {
  const minted = await input.mint();
  const sealed = await sealAttachment({
    bytes: input.bytes,
    mime: input.mime,
    name: input.name,
    objectKey: minted.objectKey,
    encrypt: input.encrypt,
  });
  await input.upload(minted.uploadUrl, sealed.ciphertextBytes);
  const clientId = input.clientId ?? newClientId();
  const senderDeviceId = UUID.test(sealed.envelope.senderDeviceId) ? sealed.envelope.senderDeviceId : undefined;
  const body: AttachmentPostBody = {
    ciphertext: sealed.messageCiphertext,
    contentType: ATTACHMENT_CONTENT_TYPE,
    clientId,
    ...(senderDeviceId ? { senderDeviceId } : {}),
  };
  await input.post(body);
  return {
    objectKey: minted.objectKey,
    messageCiphertext: sealed.messageCiphertext,
    clientId,
    senderDeviceId,
  };
}

/** Decrypt file bytes after the Signal envelope has already been opened once. */
export async function openDecryptedAttachment(
  plaintext: string,
  download: (objectKey: string) => Promise<Uint8Array>,
): Promise<OpenedAttachment> {
  const descriptor = readDescriptor(plaintext);
  const objectKey = descriptor.objectKey;
  wipe(descriptor.key);
  wipe(descriptor.nonce);
  const ciphertextBytes = await download(objectKey);
  return openAttachment({ plaintext, ciphertextBytes });
}

export async function openSealedAttachment(input: {
  messageCiphertext: string;
  decrypt: (envelope: OpaqueEnvelope) => Promise<string>;
  download: (objectKey: string) => Promise<Uint8Array>;
}): Promise<OpenedAttachment> {
  const envelope = decodeOpaqueEnvelope(input.messageCiphertext);
  if (!envelope) throw new AttachmentError();
  const plaintext = await input.decrypt(envelope);
  const descriptor = readDescriptor(plaintext);
  wipe(descriptor.key);
  wipe(descriptor.nonce);
  const ciphertextBytes = await input.download(descriptor.objectKey);
  return openAttachment({ plaintext, ciphertextBytes });
}
