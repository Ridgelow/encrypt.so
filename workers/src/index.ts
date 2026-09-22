import { requireUser, startPhone, verifyPhone } from "./auth";
import { HttpError, empty, json, readJson } from "./http";
import { createDevice, getMe, getPrekeyBundle, putPrekeyBundle } from "./identity";
import { createConversation, listConversations, listMessages, postMessage } from "./messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathOf(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  return path || "/";
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = pathOf(request);
  const method = request.method;

  if (method === "GET" && path === "/health") {
    return json({ ok: true, service: "encrypt.so" });
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
