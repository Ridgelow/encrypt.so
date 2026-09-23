import { assertAllowed, clientIp, enforceLimit, sessionsKv } from "./abuse";
import { dispatchAttachment, type AttachmentDeps, type AttachmentRecord } from "./attachments";
import { requireUser, startPhone, verifyPhone } from "./auth";
import { loadGuardConfig } from "./guard";
import { UserGate } from "./gate";
import { errorResponse, HttpError, empty, json, readJson } from "./http";
import { createDevice, getMe, getPrekeyBundle, putPrekeyBundle } from "./identity";
import {
  addGroupMember,
  createConversation,
  createGroupConversation,
  getConversation,
  listConversations,
  listMessages,
  postMessage,
  requireMember,
} from "./messages";
import { purgeExpired } from "./purge";
import { notifyNewMessage, registerPushToken, unregisterPushToken } from "./push";
import { ConversationRoom } from "./realtime";

export { ConversationRoom, UserGate };

const USER_HEADER = "x-encrypt-user-id";
const CONVERSATION_HEADER = "x-encrypt-conversation-id";
const IP_HEADER = "x-encrypt-client-ip";

function attachmentDeps(env: Env): AttachmentDeps {
  const guard = loadGuardConfig(env);
  return {
    guard,
    onLimit: async (request, userId) => {
      const kv = sessionsKv(env);
      await enforceLimit(
        kv,
        `rl:v1:att:ip:${clientIp(request)}`,
        guard.attachmentPerIp,
        guard.attachmentWindowMs,
      );
      await enforceLimit(
        kv,
        `rl:v1:att:user:${userId}`,
        guard.attachmentPerUser,
        guard.attachmentWindowMs,
      );
    },
    db: {
      prepare(query: string) {
        const statement = env.DB.prepare(query);
        return {
          bind(...values: unknown[]) {
            return {
              first<T>(): Promise<T | null> {
                return statement.bind(...values).first<T>();
              },
            };
          },
        };
      },
    },
    blobs: {
      async put(key, value) {
        await env.ATTACHMENTS.put(key, value, {
          httpMetadata: { contentType: "application/octet-stream" },
        });
      },
      async get(key) {
        const object = await env.ATTACHMENTS.get(key);
        if (!object) return null;
        return { arrayBuffer: () => object.arrayBuffer() };
      },
      async delete(key) {
        await env.ATTACHMENTS.delete(key);
      },
    },
    records: {
      async put(row: AttachmentRecord) {
        await env.DB.prepare(
          `INSERT INTO attachment_objects (object_key, conversation_id, byte_length, created_at, expire_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(object_key) DO UPDATE SET
             byte_length = excluded.byte_length,
             expire_at = excluded.expire_at`,
        )
          .bind(row.objectKey, row.conversationId, row.byteLength, row.createdAt, row.expireAt)
          .run();
      },
      async get(objectKey) {
        return env.DB.prepare(
          "SELECT conversation_id, expire_at FROM attachment_objects WHERE object_key = ?",
        )
          .bind(objectKey)
          .first<{ conversation_id: string; expire_at: number | null }>()
          .then((row) =>
            row ? { conversationId: row.conversation_id, expireAt: row.expire_at } : null,
          );
      },
      async delete(objectKey) {
        await env.DB.prepare("DELETE FROM attachment_objects WHERE object_key = ?").bind(objectKey).run();
      },
    },
    grants: {
      get: (key) => env.SESSIONS.get(key),
      put: (key, value, options) => env.SESSIONS.put(key, value, options),
      delete: (key) => env.SESSIONS.delete(key),
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGroupCreate(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && "memberUserIds" in body;
}

function pathOf(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return path || "/";
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = clientIp(request);
  const attachment = await dispatchAttachment(request, attachmentDeps(env), (req) => requireUser(req, env));
  if (attachment) return attachment;

  const path = pathOf(request);
  const method = request.method;
  const maxBody = loadGuardConfig(env).maxBodyBytes;

  if (method === "GET" && path === "/health") {
    return json({ ok: true, service: "encrypt.so" });
  }

  if (path === "/realtime") {
    return realtimeUpgrade(request, env);
  }

  if (method === "POST" && path === "/auth/phone/start") {
    return json(await startPhone(env, await readJson(request, maxBody), { ip }));
  }

  if (method === "POST" && path === "/auth/phone/verify") {
    return json(await verifyPhone(env, await readJson(request, maxBody), { ip }));
  }

  if (method === "GET" && path === "/me") {
    return json(await getMe(env, await requireUser(request, env)));
  }

  if (method === "POST" && path === "/devices") {
    const userId = await requireUser(request, env);
    return json(await createDevice(env, userId, await readJson(request, maxBody)), 201);
  }

  const bundlePut = /^\/devices\/([^/]+)\/prekey-bundle$/.exec(path);
  if (method === "PUT" && bundlePut) {
    const deviceId = bundlePut[1];
    if (!UUID.test(deviceId)) throw new HttpError(404, "device not found");
    const userId = await requireUser(request, env);
    return json(await putPrekeyBundle(env, userId, deviceId, await readJson(request, maxBody)));
  }

  const bundleGet = /^\/users\/([^/]+)\/prekey-bundle$/.exec(path);
  if (method === "GET" && bundleGet) {
    const userId = bundleGet[1];
    if (!UUID.test(userId)) throw new HttpError(404, "no prekey bundle");
    await requireUser(request, env);
    return json(await getPrekeyBundle(env, userId));
  }

  if (method === "POST" && path === "/conversations") {
    const userId = await requireUser(request, env);
    const body = await readJson(request, maxBody);
    if (isGroupCreate(body)) {
      return json(await createGroupConversation(env, userId, body), 201);
    }
    const result = await createConversation(env, userId, body);
    return json(result.conversation, result.created ? 201 : 200);
  }

  if (method === "GET" && path === "/conversations") {
    const userId = await requireUser(request, env);
    return json({ conversations: await listConversations(env, userId) });
  }

  const membersPath = /^\/conversations\/([^/]+)\/members$/.exec(path);
  if (membersPath) {
    const conversationId = membersPath[1];
    if (!UUID.test(conversationId)) throw new HttpError(404, "conversation not found");
    const userId = await requireUser(request, env);
    if (method === "GET") {
      const conversation = await getConversation(env, userId, conversationId);
      return json({ members: conversation.members });
    }
    if (method === "POST") {
      const conversation = await addGroupMember(env, userId, conversationId, await readJson(request, maxBody));
      return json(conversation);
    }
  }

  const conversationPath = /^\/conversations\/([^/]+)$/.exec(path);
  if (method === "GET" && conversationPath) {
    const conversationId = conversationPath[1];
    if (!UUID.test(conversationId)) throw new HttpError(404, "conversation not found");
    const userId = await requireUser(request, env);
    return json(await getConversation(env, userId, conversationId));
  }

  const messagesPath = /^\/conversations\/([^/]+)\/messages$/.exec(path);
  if (messagesPath) {
    const conversationId = messagesPath[1];
    if (!UUID.test(conversationId)) throw new HttpError(404, "conversation not found");
    const userId = await requireUser(request, env);
    if (method === "POST") {
      const result = await postMessage(env, userId, conversationId, await readJson(request, maxBody), { ip });
      if (result.created) {
        ctx.waitUntil(
          notifyNewMessage(env, { conversationId, senderUserId: userId }).catch(() => {
            console.error("push notify failed");
          }),
        );
      }
      return json(result.message, result.created ? 201 : 200);
    }
    if (method === "GET") {
      const url = new URL(request.url);
      return json(
        await listMessages(env, userId, conversationId, {
          cursor: url.searchParams.get("cursor"),
          limit: url.searchParams.get("limit"),
        }),
      );
    }
  }

  if (method === "POST" && path === "/push/register") {
    const userId = await requireUser(request, env);
    return json(await registerPushToken(env, userId, await readJson(request, maxBody), { ip }));
  }

  if (method === "POST" && path === "/push/unregister") {
    const userId = await requireUser(request, env);
    return json(await unregisterPushToken(env, userId, await readJson(request, maxBody), { ip }));
  }

  throw new HttpError(404, "not found");
}

/**
 * Authenticated WebSocket upgrade into the conversation Durable Object.
 * The session token is the same KV bearer token as `/me`. The token is not forwarded.
 */
async function realtimeUpgrade(request: Request, env: Env): Promise<Response> {
  const userId = await requireUser(request, env);
  const conversationId = new URL(request.url).searchParams.get("conversationId") ?? "";
  if (!UUID.test(conversationId)) throw new HttpError(400, "invalid conversationId");
  await requireMember(env, conversationId, userId);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "expected websocket");
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set(USER_HEADER, userId);
  headers.set(CONVERSATION_HEADER, conversationId);
  headers.set(IP_HEADER, clientIp(request));
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId));
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") return empty();
    try {
      if (pathOf(request) !== "/health") {
        await assertAllowed(env, { ip: clientIp(request) });
      }
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err);
      console.error(err instanceof Error ? err.name : "internal");
      return json({ error: "internal" }, 500);
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      purgeExpired(env).catch(() => {
        console.error("purge failed");
      }),
    );
  },
} satisfies ExportedHandler<Env>;
