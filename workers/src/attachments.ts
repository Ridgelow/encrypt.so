import { attachmentExpireAt, DEFAULT_MESSAGE_TTL_MS, type GuardConfig } from "./guard";
import { HttpError, isRecord, json, octet, readJson } from "./http";

/**
 * Encrypted attachment blobs.
 *
 * The worker stores opaque bytes in R2 and a short-lived upload grant in KV.
 * It does not accept a filename, a content key, or any other plaintext field.
 * Download is limited to conversation members. The Signal envelope that points
 * at the object is a normal message (`contentType: attachment/v1`) and is not
 * parsed here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_RE = /^[0-9a-f]{64}$/;
/** Ciphertext byte cap. The client leaves room for the AES-GCM tag. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const GRANT_TTL_SECONDS = 120;
const PLAINTEXT_FIELD =
  /^(plaintext|plain_text|text|body|message|content|filename|file_name|originalfilename|originalname|name)$/i;

export interface AttachmentDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

export interface AttachmentBlobs {
  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete?(key: string): Promise<void>;
}

export interface AttachmentRecord {
  objectKey: string;
  conversationId: string;
  byteLength: number;
  createdAt: number;
  expireAt: number | null;
}

export interface AttachmentRecords {
  put(row: AttachmentRecord): Promise<void>;
  get(objectKey: string): Promise<{ conversationId: string; expireAt: number | null } | null>;
  delete(objectKey: string): Promise<void>;
}

export interface AttachmentGrants {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AttachmentDeps {
  db: AttachmentDb;
  blobs: AttachmentBlobs;
  grants: AttachmentGrants;
  /** Defaults to {@link MAX_ATTACHMENT_BYTES}. */
  maxBytes?: number;
  /** When set, blobs get a retention deadline and `maxAttachmentBytes` applies. */
  guard?: GuardConfig;
  /** Mint and byte upload. Production wires the KV window limiter. */
  onLimit?: (request: Request, userId: string) => Promise<void>;
  /** D1 pointer rows. Omitted in unit tests that only check ciphertext bytes. */
  records?: AttachmentRecords;
}

type Grant = {
  objectKey: string;
  conversationId: string;
  userId: string;
  expiresAt: number;
  /** Disappearing-message deadline, when the client sent one. Not a content key. */
  expireAt: number | null;
};

function rejectSensitiveFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSensitiveFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/private/i.test(key)) throw new HttpError(400, "private keys are not accepted");
    if (PLAINTEXT_FIELD.test(key)) throw new HttpError(400, "plaintext is not accepted");
    rejectSensitiveFields(child);
  }
}

function randomGrant(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function grantKey(token: string): string {
  return `att-grant:${token}`;
}

function objectPath(conversationId: string, objectKey: string): string {
  return `${conversationId}/${objectKey}`;
}

async function assertMember(db: AttachmentDb, conversationId: string, userId: string): Promise<void> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM memberships WHERE conversation_id = ? AND user_id = ?")
    .bind(conversationId, userId)
    .first<{ ok: number }>();
  if (!row) throw new HttpError(404, "conversation not found");
}

function maxBytesOf(deps: AttachmentDeps): number {
  return deps.guard?.maxAttachmentBytes ?? deps.maxBytes ?? MAX_ATTACHMENT_BYTES;
}

async function limitAttachment(deps: AttachmentDeps, request: Request, userId: string): Promise<void> {
  await deps.onLimit?.(request, userId);
}

function requestedExpire(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= Date.now()) {
    throw new HttpError(400, "invalid expireAt");
  }
  return value;
}

async function createUpload(
  request: Request,
  deps: AttachmentDeps,
  userId: string,
  conversationId: string,
): Promise<Response> {
  const body = await readJson(request);
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectSensitiveFields(body);
  for (const key of Object.keys(body)) {
    if (key !== "expireAt") throw new HttpError(400, "unexpected field");
  }
  const expireAt = requestedExpire(body.expireAt);
  await assertMember(deps.db, conversationId, userId);
  await limitAttachment(deps, request, userId);

  const objectKey = crypto.randomUUID();
  const token = randomGrant();
  const expiresAt = Date.now() + GRANT_TTL_SECONDS * 1000;
  const grant: Grant = { objectKey, conversationId, userId, expiresAt, expireAt };
  await deps.grants.put(grantKey(token), JSON.stringify(grant), { expirationTtl: GRANT_TTL_SECONDS });

  const uploadUrl = new URL(request.url);
  uploadUrl.pathname = `/attachments/${objectKey}`;
  uploadUrl.search = "";
  uploadUrl.hash = "";
  uploadUrl.searchParams.set("grant", token);
  return json(
    { objectKey, uploadUrl: uploadUrl.toString(), expiresAt },
    201,
    { "cache-control": "no-store" },
  );
}

async function putAttachment(request: Request, deps: AttachmentDeps, objectKey: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get("grant") ?? "";
  if (!GRANT_RE.test(token)) throw new HttpError(401, "invalid upload grant");
  const stored = await deps.grants.get(grantKey(token));
  if (!stored) throw new HttpError(401, "invalid upload grant");

  let grant: Grant;
  try {
    grant = JSON.parse(stored) as Grant;
  } catch {
    await deps.grants.delete(grantKey(token));
    throw new HttpError(401, "invalid upload grant");
  }
  if (typeof grant.expireAt !== "number" || !Number.isInteger(grant.expireAt)) {
    grant.expireAt = null;
  }
  if (
    grant.objectKey !== objectKey ||
    grant.expiresAt <= Date.now() ||
    !UUID.test(grant.conversationId) ||
    !UUID.test(grant.userId)
  ) {
    await deps.grants.delete(grantKey(token));
    throw new HttpError(401, "invalid upload grant");
  }

  const member = await deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE conversation_id = ? AND user_id = ?")
    .bind(grant.conversationId, grant.userId)
    .first<{ ok: number }>();
  if (!member) {
    await deps.grants.delete(grantKey(token));
    throw new HttpError(404, "conversation not found");
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json" || type === "text/plain" || type.startsWith("multipart/")) {
    throw new HttpError(400, "plaintext is not accepted");
  }
  if (type !== "application/octet-stream") throw new HttpError(400, "invalid attachment");

  const limit = maxBytesOf(deps);
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader != null) {
    if (!/^\d+$/.test(lengthHeader)) throw new HttpError(400, "invalid attachment");
    const declared = Number(lengthHeader);
    if (declared > limit) throw new HttpError(413, "attachment too large");
    if (declared < 1) throw new HttpError(400, "invalid attachment");
  }
  await limitAttachment(deps, request, grant.userId);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new HttpError(413, "attachment too large");
  if (bytes.byteLength < 1) throw new HttpError(400, "invalid attachment");
  if (lengthHeader != null && Number(lengthHeader) !== bytes.byteLength) {
    throw new HttpError(400, "invalid attachment");
  }

  await deps.grants.delete(grantKey(token));
  await deps.blobs.put(objectPath(grant.conversationId, grant.objectKey), bytes);
  if (deps.records) {
    const now = Date.now();
    const ttl = deps.guard?.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS;
    await deps.records.put({
      objectKey: grant.objectKey,
      conversationId: grant.conversationId,
      byteLength: bytes.byteLength,
      createdAt: now,
      expireAt: attachmentExpireAt(now, grant.expireAt, ttl),
    });
  }
  return json({ objectKey: grant.objectKey, byteLength: bytes.byteLength }, 201, { "cache-control": "no-store" });
}

async function downloadAttachment(
  deps: AttachmentDeps,
  userId: string,
  conversationId: string,
  objectKey: string,
): Promise<Response> {
  await assertMember(deps.db, conversationId, userId);
  if (deps.records) {
    const pointer = await deps.records.get(objectKey);
    if (pointer && pointer.expireAt != null && pointer.expireAt <= Date.now()) {
      await deps.records.delete(objectKey);
      await deps.blobs.delete?.(objectPath(conversationId, objectKey));
      throw new HttpError(404, "attachment not found");
    }
  }
  const stored = await deps.blobs.get(objectPath(conversationId, objectKey));
  if (!stored) throw new HttpError(404, "attachment not found");
  return octet(await stored.arrayBuffer());
}

/**
 * Attachment routes. Returns null when the path is not an attachment route.
 * `authenticate` is the existing session check (`requireUser`). Upload PUT
 * uses the single-use grant in the query string instead of the session.
 */
export async function dispatchAttachment(
  request: Request,
  deps: AttachmentDeps,
  authenticate: (request: Request) => Promise<string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  const method = request.method;

  const mint = /^\/conversations\/([^/]+)\/attachments$/.exec(path);
  if (mint && method === "POST") {
    const conversationId = mint[1] ?? "";
    if (!UUID.test(conversationId)) throw new HttpError(404, "conversation not found");
    const userId = await authenticate(request);
    return createUpload(request, deps, userId, conversationId);
  }

  const download = /^\/conversations\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
  if (download && method === "GET") {
    const conversationId = download[1] ?? "";
    const objectKey = download[2] ?? "";
    if (!UUID.test(conversationId) || !UUID.test(objectKey)) throw new HttpError(404, "attachment not found");
    const userId = await authenticate(request);
    return downloadAttachment(deps, userId, conversationId, objectKey);
  }

  const upload = /^\/attachments\/([^/]+)$/.exec(path);
  if (upload && method === "PUT") {
    const objectKey = upload[1] ?? "";
    if (!UUID.test(objectKey)) throw new HttpError(404, "attachment not found");
    return putAttachment(request, deps, objectKey);
  }

  return null;
}
