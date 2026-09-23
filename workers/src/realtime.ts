import { admitRoom, loadGuardConfig } from "./guard";
import { errorResponse, HttpError, isRecord } from "./http";
import { postMessage, requireMember } from "./messages";
import { notifyNewMessage } from "./push";

/**
 * Realtime fan-out for one conversation, including an N-member group.
 *
 * The object is named by conversation id, so every member's WebSocket is
 * already in the same place and a send is a local broadcast. A per-user inbox
 * would have to look up each peer and forward to another object on every
 * envelope. Membership and ciphertext rows stay in D1 through the existing
 * conversation routes — this object does not create tables.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CIPHERTEXT_RE = /^[A-Za-z0-9+/_-]{4,}={0,2}$/;
const CONTENT_TYPE_RE = /^[\w!#$&^_.+-]{1,64}(?:\/[\w!#$&^_.+-]{1,64})?$/;
const CLIENT_ID_RE = /^[\w.-]{1,64}$/;
const PLAINTEXT_FIELD = /^(plaintext|plain_text|text|body|message|content)$/i;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const MAX_FRAME_CHARS = 96 * 1024;

const USER_HEADER = "x-encrypt-user-id";
const CONVERSATION_HEADER = "x-encrypt-conversation-id";
const IP_HEADER = "x-encrypt-client-ip";

type SocketState = {
  userId: string;
  subscribed: boolean;
  ip: string;
  released?: boolean;
};

export type ClientFrame =
  | { type: "subscribe"; conversationId: string }
  | {
      type: "message";
      conversationId: string;
      ciphertext: string;
      contentType: string;
      clientId: string | null;
      senderDeviceId: string | null;
      expireAt: number | null;
    };

export type ParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: string; clientId: string | null };

function rejectOpaqueFields(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = rejectOpaqueFields(item);
      if (error) return error;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (/private/i.test(key)) return "private keys are not accepted";
    if (PLAINTEXT_FIELD.test(key)) return "plaintext is not accepted";
    const nested = rejectOpaqueFields(child);
    if (nested) return nested;
  }
  return null;
}

function clientIdOf(value: unknown): string | null {
  if (!isRecord(value) || typeof value.clientId !== "string") return null;
  return CLIENT_ID_RE.test(value.clientId) ? value.clientId : null;
}

function parseExpireAt(value: unknown): number | null | string {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= Date.now()) {
    return "invalid expireAt";
  }
  return value;
}

/** Parse one client frame. Plaintext and private-key field names are refused. */
export function parseClientFrame(raw: string, maxCiphertextChars = 49152): ParseResult {
  if (raw.length > MAX_FRAME_CHARS) return { ok: false, error: "frame too large", clientId: null };
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "invalid json", clientId: null };
  }
  const clientId = clientIdOf(body);
  const opaque = rejectOpaqueFields(body);
  if (opaque) return { ok: false, error: opaque, clientId };
  if (!isRecord(body)) return { ok: false, error: "invalid frame", clientId };

  if (body.type === "subscribe") {
    if (typeof body.conversationId !== "string" || !UUID.test(body.conversationId)) {
      return { ok: false, error: "invalid conversationId", clientId };
    }
    return { ok: true, frame: { type: "subscribe", conversationId: body.conversationId } };
  }

  if (body.type !== "message") return { ok: false, error: "invalid frame", clientId };
  if (typeof body.conversationId !== "string" || !UUID.test(body.conversationId)) {
    return { ok: false, error: "invalid conversationId", clientId };
  }
  if (typeof body.ciphertext !== "string" || body.ciphertext.length < 4) {
    return { ok: false, error: "invalid ciphertext", clientId };
  }
  if (body.ciphertext.length > maxCiphertextChars) {
    return { ok: false, error: "envelope too large", clientId };
  }
  if (!CIPHERTEXT_RE.test(body.ciphertext)) {
    return { ok: false, error: "invalid ciphertext", clientId };
  }
  let contentType = DEFAULT_CONTENT_TYPE;
  if (body.contentType != null) {
    if (typeof body.contentType !== "string" || !CONTENT_TYPE_RE.test(body.contentType)) {
      return { ok: false, error: "invalid contentType", clientId };
    }
    contentType = body.contentType;
  }
  if (body.clientId != null && clientId == null) return { ok: false, error: "invalid clientId", clientId: null };
  let senderDeviceId: string | null = null;
  if (body.senderDeviceId != null) {
    if (typeof body.senderDeviceId !== "string" || !UUID.test(body.senderDeviceId)) {
      return { ok: false, error: "invalid senderDeviceId", clientId };
    }
    senderDeviceId = body.senderDeviceId;
  }
  const expireAt = parseExpireAt(body.expireAt);
  if (typeof expireAt === "string") return { ok: false, error: expireAt, clientId };

  return {
    ok: true,
    frame: {
      type: "message",
      conversationId: body.conversationId,
      ciphertext: body.ciphertext,
      contentType,
      clientId,
      senderDeviceId,
      expireAt,
    },
  };
}

function sendJson(ws: WebSocket, body: unknown): void {
  try {
    ws.send(JSON.stringify(body));
  } catch {
    // The peer socket may already be closing.
  }
}

function stateOf(ws: WebSocket): SocketState | null {
  const value = ws.deserializeAttachment() as SocketState | null;
  if (!value || typeof value.userId !== "string") return null;
  if (typeof value.ip !== "string") value.ip = "unknown";
  return value;
}

export class ConversationRoom implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const userId = request.headers.get(USER_HEADER);
    const conversationId = request.headers.get(CONVERSATION_HEADER);
    if (!userId || !conversationId || !UUID.test(conversationId)) {
      return new Response("unauthorized", { status: 401 });
    }

    const stored = await this.ctx.storage.get<string>("conversationId");
    if (stored && stored !== conversationId) {
      return new Response("conversation mismatch", { status: 409 });
    }
    if (!stored) await this.ctx.storage.put("conversationId", conversationId);

    const limits = loadGuardConfig(this.env);
    const admission = admitRoom({
      roomTotal: this.ctx.getWebSockets().length,
      roomForUser: this.ctx.getWebSockets(userId).length,
      maxPerConversation: limits.maxWsPerConversation,
      maxPerUserInRoom: limits.maxWsPerUser,
    });
    if (!admission.ok) {
      return errorResponse(new HttpError(429, "too many connections", { retryAfter: admission.retryAfterSeconds }));
    }
    const reserved = await this.reserveUser(userId);
    if (reserved) return reserved;

    const ip = request.headers.get(IP_HEADER) ?? "unknown";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    try {
      this.ctx.acceptWebSocket(server, [userId]);
      server.serializeAttachment({ userId, subscribed: false, ip, released: false } satisfies SocketState);
    } catch (err) {
      await this.releaseUser(userId);
      throw err;
    }
    sendJson(server, { type: "ready", userId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = parseClientFrame(raw, loadGuardConfig(this.env).maxCiphertextChars);
    if (!parsed.ok) {
      sendJson(ws, { type: "error", error: parsed.error, clientId: parsed.clientId });
      return;
    }

    const conversationId = await this.ctx.storage.get<string>("conversationId");
    const state = stateOf(ws);
    if (!conversationId || !state) {
      sendJson(ws, { type: "error", error: "not subscribed", clientId: null });
      return;
    }
    if (parsed.frame.conversationId !== conversationId) {
      sendJson(ws, {
        type: "error",
        error: "invalid conversationId",
        clientId: parsed.frame.type === "message" ? parsed.frame.clientId : null,
      });
      return;
    }

    try {
      await requireMember(this.env, conversationId, state.userId);
    } catch (err) {
      const error = err instanceof HttpError ? err.message : "conversation not found";
      sendJson(ws, { type: "error", error, clientId: null });
      ws.close(1008, "not a member");
      return;
    }

    if (parsed.frame.type === "subscribe") {
      const next: SocketState = { userId: state.userId, subscribed: true, ip: state.ip };
      ws.serializeAttachment(next);
      sendJson(ws, { type: "subscribed", conversationId });
      return;
    }

    if (!state.subscribed) {
      sendJson(ws, { type: "error", error: "subscribe required", clientId: parsed.frame.clientId });
      return;
    }

    let persisted: { id: string; createdAt: number; senderDeviceId: string } | null;
    try {
      persisted = await this.persist(state.userId, state.ip, parsed.frame);
    } catch (err) {
      const error = err instanceof HttpError ? err.message : "persist failed";
      sendJson(ws, { type: "error", error, clientId: parsed.frame.clientId });
      return;
    }
    const outbound = {
      type: "message",
      conversationId,
      ciphertext: parsed.frame.ciphertext,
      contentType: parsed.frame.contentType,
      clientId: parsed.frame.clientId,
      senderDeviceId: persisted?.senderDeviceId ?? parsed.frame.senderDeviceId,
      expireAt: parsed.frame.expireAt,
      fromUserId: state.userId,
      id: persisted?.id ?? null,
      createdAt: persisted?.createdAt ?? Date.now(),
    };
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      const peerState = stateOf(peer);
      if (!peerState?.subscribed) continue;
      sendJson(peer, outbound);
    }
    sendJson(ws, {
      type: "ack",
      conversationId,
      clientId: parsed.frame.clientId,
      id: persisted?.id ?? null,
    });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.drop(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.drop(ws);
  }

  private async reserveUser(userId: string): Promise<Response | null> {
    const gate = this.env.USER_GATES.get(this.env.USER_GATES.idFromName(userId));
    const response = await gate.fetch("https://user-gate/reserve", { method: "POST" });
    if (response.status === 204) return null;
    return response;
  }

  private async releaseUser(userId: string): Promise<void> {
    const gate = this.env.USER_GATES.get(this.env.USER_GATES.idFromName(userId));
    await gate.fetch("https://user-gate/release", { method: "POST" });
  }

  private async drop(ws: WebSocket): Promise<void> {
    const state = stateOf(ws);
    if (!state || state.released) return;
    ws.serializeAttachment({ ...state, released: true });
    try {
      await this.releaseUser(state.userId);
    } catch {
      console.error("connection release failed");
    }
  }

  /**
   * Best-effort D1 write through the existing ciphertext route.
   * Fan-out still happens when the device row is missing or the write fails.
   */
  private async persist(
    userId: string,
    ip: string,
    frame: Extract<ClientFrame, { type: "message" }>,
  ): Promise<{ id: string; createdAt: number; senderDeviceId: string } | null> {
    const body: Record<string, unknown> = {
      ciphertext: frame.ciphertext,
      contentType: frame.contentType,
    };
    if (frame.clientId) body.clientId = frame.clientId;
    if (frame.senderDeviceId) body.senderDeviceId = frame.senderDeviceId;
    if (frame.expireAt != null) body.expireAt = frame.expireAt;
    try {
      const result = await postMessage(this.env, userId, frame.conversationId, body, { ip });
      if (result.created) {
        const conversationId = frame.conversationId;
        this.ctx.waitUntil(
          notifyNewMessage(this.env, { conversationId, senderUserId: userId }).catch(() => {
            console.error("push notify failed");
          }),
        );
      }
      return {
        id: result.message.id,
        createdAt: result.message.createdAt,
        senderDeviceId: result.message.senderDeviceId,
      };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 429 || err.status === 413)) throw err;
      const message = err instanceof Error ? err.message : "persist failed";
      console.warn(`realtime persist skipped: ${message}`);
      return null;
    }
  }
}
