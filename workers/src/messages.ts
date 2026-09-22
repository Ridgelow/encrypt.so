import { HttpError, isRecord, rejectPrivateFields } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIPHERTEXT_RE = /^[A-Za-z0-9+/_-]{4,49152}={0,2}$/;
const CONTENT_TYPE_RE = /^[\w!#$&^_.+-]{1,64}(?:\/[\w!#$&^_.+-]{1,64})?$/;
const CLIENT_ID_RE = /^[\w.-]{1,64}$/;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const PLAINTEXT_FIELD = /^(plaintext|plain_text|text|body|message|content)$/i;

export type Member = {
  userId: string;
  joinedAt: number;
};

export type Conversation = {
  id: string;
  createdAt: number;
  members: Member[];
};

export type CiphertextMessage = {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  ciphertext: string;
  contentType: string;
  createdAt: number;
  expireAt: number | null;
  clientId: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  ciphertext: string;
  content_type: string;
  created_at: number;
  expire_at: number | null;
  client_id: string | null;
};

function rejectPlaintextFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPlaintextFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (PLAINTEXT_FIELD.test(key)) throw new HttpError(400, "plaintext is not accepted");
    rejectPlaintextFields(child);
  }
}

function checkedBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  rejectPlaintextFields(body);
  return body;
}

function asUuid(value: unknown, field: string, status = 400): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(status, `invalid ${field}`);
  return value;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

function toMessage(row: MessageRow): CiphertextMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderDeviceId: row.sender_device_id,
    ciphertext: row.ciphertext,
    contentType: row.content_type,
    createdAt: row.created_at,
    expireAt: row.expire_at,
    clientId: row.client_id,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

async function loadConversation(env: Env, id: string): Promise<Conversation | null> {
  const row = await env.DB.prepare("SELECT id, created_at FROM conversations WHERE id = ?")
    .bind(id)
    .first<{ id: string; created_at: number }>();
  if (!row) return null;
  const members = await env.DB.prepare(
    "SELECT user_id, joined_at FROM memberships WHERE conversation_id = ? ORDER BY user_id ASC",
  )
    .bind(id)
    .all<{ user_id: string; joined_at: number }>();
  return {
    id: row.id,
    createdAt: row.created_at,
    members: members.results.map((member) => ({ userId: member.user_id, joinedAt: member.joined_at })),
  };
}

async function findDirect(env: Env, userId: string, peerUserId: string): Promise<Conversation | null> {
  const row = await env.DB.prepare("SELECT id FROM conversations WHERE pair_key = ?")
    .bind(pairKey(userId, peerUserId))
    .first<{ id: string }>();
  if (!row) return null;
  return loadConversation(env, row.id);
}

/**
 * POST /conversations
 * { peerUserId } → 1:1 conversation. Repeating the same pair returns the existing row.
 */
export async function createConversation(
  env: Env,
  userId: string,
  body: unknown,
): Promise<{ conversation: Conversation; created: boolean }> {
  const record = checkedBody(body);
  if (record.peerUserId == null) throw new HttpError(400, "peerUserId required");
  const peerUserId = asUuid(record.peerUserId, "peerUserId");
  if (peerUserId === userId) throw new HttpError(400, "cannot message yourself");

  const peer = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(peerUserId)
    .first<{ id: string }>();
  if (!peer) throw new HttpError(404, "user not found");

  const existing = await findDirect(env, userId, peerUserId);
  if (existing) return { conversation: existing, created: false };

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO conversations (id, created_at, pair_key) VALUES (?, ?, ?)").bind(
        id,
        createdAt,
        pairKey(userId, peerUserId),
      ),
      env.DB.prepare(
        "INSERT INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)",
      ).bind(id, userId, createdAt),
      env.DB.prepare(
        "INSERT INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)",
      ).bind(id, peerUserId, createdAt),
    ]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await findDirect(env, userId, peerUserId);
    if (raced) return { conversation: raced, created: false };
    throw err;
  }

  return {
    created: true,
    conversation: {
      id,
      createdAt,
      members: [
        { userId, joinedAt: createdAt },
        { userId: peerUserId, joinedAt: createdAt },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    },
  };
}

/** GET /conversations — memberships for the signed-in user. No message bodies. */
export async function listConversations(env: Env, userId: string): Promise<Conversation[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.created_at
     FROM conversations c
     INNER JOIN memberships mine ON mine.conversation_id = c.id AND mine.user_id = ?
     ORDER BY c.created_at DESC, c.id ASC`,
  )
    .bind(userId)
    .all<{ id: string; created_at: number }>();
  if (rows.results.length === 0) return [];

  const ids = rows.results.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");
  const members = await env.DB.prepare(
    `SELECT conversation_id, user_id, joined_at
     FROM memberships
     WHERE conversation_id IN (${placeholders})
     ORDER BY user_id ASC`,
  )
    .bind(...ids)
    .all<{ conversation_id: string; user_id: string; joined_at: number }>();

  const byConversation = new Map<string, Member[]>();
  for (const member of members.results) {
    const list = byConversation.get(member.conversation_id) ?? [];
    list.push({ userId: member.user_id, joinedAt: member.joined_at });
    byConversation.set(member.conversation_id, list);
  }

  return rows.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    members: byConversation.get(row.id) ?? [],
  }));
}

async function requireMember(env: Env, conversationId: string, userId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM memberships WHERE conversation_id = ? AND user_id = ?",
  )
    .bind(conversationId, userId)
    .first<{ ok: number }>();
  if (!row) throw new HttpError(404, "conversation not found");
}

async function resolveSenderDevice(env: Env, userId: string, requested: unknown): Promise<string> {
  if (requested != null) {
    const deviceId = asUuid(requested, "senderDeviceId");
    const owned = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .bind(deviceId, userId)
      .first<{ id: string }>();
    if (!owned) throw new HttpError(404, "device not found");
    return owned.id;
  }

  const devices = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC, id ASC")
    .bind(userId)
    .all<{ id: string }>();
  if (devices.results.length === 0) throw new HttpError(400, "device required");
  if (devices.results.length > 1) throw new HttpError(400, "senderDeviceId required");
  return devices.results[0].id;
}

function parseCiphertext(value: unknown): string {
  if (typeof value !== "string" || !CIPHERTEXT_RE.test(value)) {
    throw new HttpError(400, "invalid ciphertext");
  }
  return value;
}

function parseContentType(value: unknown): string {
  if (value == null) return DEFAULT_CONTENT_TYPE;
  if (typeof value !== "string" || !CONTENT_TYPE_RE.test(value)) {
    throw new HttpError(400, "invalid contentType");
  }
  return value;
}

function parseClientId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !CLIENT_ID_RE.test(value)) throw new HttpError(400, "invalid clientId");
  return value;
}

function parseExpireAt(value: unknown, createdAt: number): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= createdAt) {
    throw new HttpError(400, "invalid expireAt");
  }
  return value;
}

async function findClientMessage(
  env: Env,
  conversationId: string,
  senderDeviceId: string,
  clientId: string,
): Promise<CiphertextMessage | null> {
  const row = await env.DB.prepare(
    `SELECT id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id
     FROM messages
     WHERE conversation_id = ? AND sender_device_id = ? AND client_id = ?`,
  )
    .bind(conversationId, senderDeviceId, clientId)
    .first<MessageRow>();
  return row ? toMessage(row) : null;
}

function samePayload(existing: CiphertextMessage, next: {
  ciphertext: string;
  contentType: string;
  expireAt: number | null;
}): boolean {
  return (
    existing.ciphertext === next.ciphertext &&
    existing.contentType === next.contentType &&
    existing.expireAt === next.expireAt
  );
}

/**
 * POST /conversations/:id/messages
 * { ciphertext, contentType?, clientId?, senderDeviceId?, expireAt? }
 * Stores the ciphertext unchanged. Plaintext field names are rejected.
 */
export async function postMessage(
  env: Env,
  userId: string,
  conversationId: string,
  body: unknown,
): Promise<{ message: CiphertextMessage; created: boolean }> {
  const record = checkedBody(body);
  if (record.ciphertext == null) throw new HttpError(400, "ciphertext required");
  const ciphertext = parseCiphertext(record.ciphertext);
  const contentType = parseContentType(record.contentType);
  const clientId = parseClientId(record.clientId);
  const createdAt = Date.now();
  const expireAt = parseExpireAt(record.expireAt, createdAt);

  await requireMember(env, conversationId, userId);
  const senderDeviceId = await resolveSenderDevice(env, userId, record.senderDeviceId);

  if (clientId) {
    const existing = await findClientMessage(env, conversationId, senderDeviceId, clientId);
    if (existing) {
      if (!samePayload(existing, { ciphertext, contentType, expireAt })) {
        throw new HttpError(409, "clientId already used");
      }
      return { message: existing, created: false };
    }
  }

  const id = crypto.randomUUID();
  const message: CiphertextMessage = {
    id,
    conversationId,
    senderDeviceId,
    ciphertext,
    contentType,
    createdAt,
    expireAt,
    clientId,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO messages (
         id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, conversationId, senderDeviceId, ciphertext, contentType, createdAt, expireAt, clientId)
      .run();
  } catch (err) {
    if (!(clientId && isUniqueViolation(err))) throw err;
    const existing = await findClientMessage(env, conversationId, senderDeviceId, clientId);
    if (!existing) throw err;
    if (!samePayload(existing, { ciphertext, contentType, expireAt })) {
      throw new HttpError(409, "clientId already used");
    }
    return { message: existing, created: false };
  }
  return { message, created: true };
}

function parseLimit(raw: string | null): number {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid limit");
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) throw new HttpError(400, "invalid limit");
  return limit;
}

/**
 * GET /conversations/:id/messages?cursor=&limit=
 * Pages oldest-first. `cursor` is a message id from `nextCursor`. Expired rows are omitted.
 */
export async function listMessages(
  env: Env,
  userId: string,
  conversationId: string,
  query: { cursor: string | null; limit: string | null },
): Promise<{ messages: CiphertextMessage[]; nextCursor: string | null }> {
  await requireMember(env, conversationId, userId);
  const limit = parseLimit(query.limit);
  const now = Date.now();

  let cursorCreatedAt: number | null = null;
  let cursorId: string | null = null;
  if (query.cursor) {
    if (!UUID.test(query.cursor)) throw new HttpError(400, "invalid cursor");
    const cursor = await env.DB.prepare(
      "SELECT id, created_at FROM messages WHERE id = ? AND conversation_id = ?",
    )
      .bind(query.cursor, conversationId)
      .first<{ id: string; created_at: number }>();
    if (!cursor) throw new HttpError(400, "invalid cursor");
    cursorCreatedAt = cursor.created_at;
    cursorId = cursor.id;
  }

  const rows = cursorId
    ? await env.DB.prepare(
        `SELECT id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id
         FROM messages
         WHERE conversation_id = ?
           AND (expire_at IS NULL OR expire_at > ?)
           AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
        .bind(conversationId, now, cursorCreatedAt, cursorCreatedAt, cursorId, limit + 1)
        .all<MessageRow>()
    : await env.DB.prepare(
        `SELECT id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id
         FROM messages
         WHERE conversation_id = ?
           AND (expire_at IS NULL OR expire_at > ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
        .bind(conversationId, now, limit + 1)
        .all<MessageRow>();

  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = page[page.length - 1];
  return {
    messages: page.map(toMessage),
    nextCursor: hasMore && last ? last.id : null,
  };
}
