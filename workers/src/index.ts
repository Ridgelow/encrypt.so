import { dispatchAttachment, type AttachmentDeps } from "./attachments";
import { requireUser, startPhone, verifyPhone } from "./auth";
import { HttpError, empty, json, readJson } from "./http";
import { createDevice, getMe, getPrekeyBundle, putPrekeyBundle } from "./identity";
import { createConversation, listConversations, listMessages, postMessage, requireMember } from "./messages";
import { ConversationRoom } from "./realtime";

export { ConversationRoom };

const USER_HEADER = "x-encrypt-user-id";
const CONVERSATION_HEADER = "x-encrypt-conversation-id";

function attachmentDeps(env: Env): AttachmentDeps {
  return {
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
    },
    grants: {
      get: (key) => env.SESSIONS.get(key),
      put: (key, value, options) => env.SESSIONS.put(key, value, options),
      delete: (key) => env.SESSIONS.delete(key),
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathOf(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return path || "/";
}

async function route(request: Request, env: Env): Promise<Response> {
  const attachment = await dispatchAttachment(request, attachmentDeps(env), (req) => requireUser(req, env));
  if (attachment) return attachment;

  const path = pathOf(request);
  const method = request.method;

  if (method === "GET" && path === "/health") {
    return json({ ok: true, service: "encrypt.so" });
  }

  if (path === "/realtime") {
    return realtimeUpgrade(request, env);
  }

  if (method === "POST" && path === "/auth/phone/start") {
    return json(await startPhone(env, await readJson(request)));
  }

  if (method === "POST" && path === "/auth/phone/verify") {
    return json(await verifyPhone(env, await readJson(request)));
  }

  if (method === "GET" && path === "/me") {
    return json(await getMe(env, await requireUser(request, env)));
  }

  if (method === "POST" && path === "/devices") {
    const userId = await requireUser(request, env);
    return json(await createDevice(env, userId, await readJson(request)), 201);
  }

  const bundlePut = /^\/devices\/([^/]+)\/prekey-bundle$/.exec(path);
  if (method === "PUT" && bundlePut) {
    const deviceId = bundlePut[1];
    if (!UUID.test(deviceId)) throw new HttpError(404, "device not found");
    const userId = await requireUser(request, env);
    return json(await putPrekeyBundle(env, userId, deviceId, await readJson(request)));
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
    const result = await createConversation(env, userId, await readJson(request));
    return json(result.conversation, result.created ? 201 : 200);
  }

  if (method === "GET" && path === "/conversations") {
    const userId = await requireUser(request, env);
    return json({ conversations: await listConversations(env, userId) });
  }

  const messagesPath = /^\/conversations\/([^/]+)\/messages$/.exec(path);
  if (messagesPath) {
    const conversationId = messagesPath[1];
    if (!UUID.test(conversationId)) throw new HttpError(404, "conversation not found");
    const userId = await requireUser(request, env);
    if (method === "POST") {
      const result = await postMessage(env, userId, conversationId, await readJson(request));
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
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId));
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === "OPTIONS") return empty();
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
