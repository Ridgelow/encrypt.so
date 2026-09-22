import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPushClient } from "../src/services/api";
import { ApiError } from "../src/services/errors";
import {
  inboxConversationId,
  registrationBody,
  serverDeviceIdFromRecord,
  shouldOpenInboxFromLaunch,
} from "../src/services/push-metadata";
import { HttpError } from "../workers/src/http";
import {
  PUSH_TITLE,
  buildNewMessagePush,
  deliverExpoPushes,
  parsePushRegistration,
  parsePushUnregister,
  type ExpoPushMessage,
} from "../workers/src/push-contract";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const conversationId = "11111111-1111-4111-8111-111111111111";
const ciphertext = "b3BhcXVlLWNpcGhlcnRleHQtYmxvYg==";
const token = "ExponentPushToken[alice-device]";

function sqlTables(file: string): string {
  return readFileSync(path.join(root, file), "utf8")
    .split(";")
    .map((statement) => statement.replace(/--[^\n]*/g, ""))
    .join(";");
}

describe("metadata-only Expo push", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores push tokens and has no message columns", () => {
    const sql = sqlTables("workers/migrations/0003_push_tokens.sql");
    expect(sql).toMatch(/CREATE TABLE push_tokens/);
    expect(sql).toMatch(/expo_push_token TEXT PRIMARY KEY/);
    expect(sql).toMatch(/user_id TEXT NOT NULL/);
    expect(sql).toMatch(/device_id TEXT/);
    expect(sql).not.toMatch(/\b(plaintext|plain_text|ciphertext|preview|body|message_text)\b/i);
  });

  it("notifies from the message route with ids only", () => {
    const index = readFileSync(path.join(root, "workers/src/index.ts"), "utf8");
    const push = readFileSync(path.join(root, "workers/src/push.ts"), "utf8");
    expect(index).toContain("if (result.created)");
    expect(index).toContain("notifyNewMessage(env, { conversationId, senderUserId: userId })");
    expect(index).not.toMatch(/notifyNewMessage\([\s\S]*ciphertext/);
    expect(push).toMatch(/WHERE t\.user_id != \?/);
    expect(push).not.toMatch(/FROM messages/);
    expect(push).not.toMatch(/\b(ciphertext|plaintext|preview)\b/i);
  });

  it("builds a generic payload and refuses message fields", async () => {
    const message = buildNewMessagePush(token, conversationId);
    expect(message).toEqual({
      to: token,
      title: PUSH_TITLE,
      body: PUSH_TITLE,
      data: { conversationId, unread: true },
      sound: "default",
      priority: "high",
      channelId: "messages",
    });
    expect(JSON.stringify(message)).not.toContain(ciphertext);
    expect(Object.keys(message.data).sort()).toEqual(["conversationId", "unread"]);

    const dirty = {
      ...message,
      data: { ...message.data, ciphertext },
    } as ExpoPushMessage;
    await expect(
      deliverExpoPushes({
        accessToken: "secret",
        messages: [dirty],
        fetchImpl: () => {
          throw new Error("fetch should not run");
        },
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects registration bodies that carry message content", () => {
    expect(parsePushRegistration({ expoPushToken: token, platform: "ios" })).toEqual({
      expoPushToken: token,
      platform: "ios",
      deviceId: null,
    });
    expect(
      parsePushRegistration({
        expoPushToken: token,
        platform: "android",
        deviceId: conversationId,
      }).deviceId,
    ).toBe(conversationId);
    expect(() => parsePushRegistration({ expoPushToken: token, platform: "ios", plaintext: "hi" })).toThrow(
      /plaintext is not accepted/,
    );
    expect(() => parsePushRegistration({ expoPushToken: token, platform: "ios", ciphertext })).toThrow(
      /plaintext is not accepted/,
    );
    expect(() => parsePushRegistration({ expoPushToken: token, platform: "ios", preview: "hey" })).toThrow(
      /plaintext is not accepted/,
    );
    expect(() => parsePushRegistration({ expoPushToken: token, platform: "ios", privateKey: "nope" })).toThrow(
      /private keys are not accepted/,
    );
    expect(() => parsePushUnregister({ expoPushToken: token, body: "hello" })).toThrow(HttpError);
    expect(parsePushUnregister({ expoPushToken: token })).toBe(token);
  });

  it("stubs delivery when EXPO_ACCESS_TOKEN is missing", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const fetchImpl = vi.fn();
    const delivery = await deliverExpoPushes({
      accessToken: undefined,
      messages: [buildNewMessagePush(token, conversationId)],
      fetchImpl,
    });
    expect(delivery).toEqual({ mode: "stub", attempted: 1, accepted: 0, droppedTokens: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("push stub count=1 reason=missing EXPO_ACCESS_TOKEN");
    expect(logs.join("\n")).not.toContain(ciphertext);
    expect(logs.join("\n")).not.toContain(token);
  });

  it("posts metadata to Expo and drops unregistered tokens", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const delivery = await deliverExpoPushes({
      accessToken: "expo-access-token",
      messages: [
        buildNewMessagePush(token, conversationId),
        buildNewMessagePush("ExponentPushToken[bob-device]", conversationId),
      ],
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          authorization: headers.get("authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return Response.json({
          data: [
            { status: "ok", id: "ticket-1" },
            {
              status: "error",
              message: "not registered",
              details: { error: "DeviceNotRegistered" },
            },
          ],
        });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(calls[0]?.authorization).toBe("Bearer expo-access-token");
    expect(JSON.stringify(calls[0]?.body)).not.toContain(ciphertext);
    expect(calls[0]?.body).toEqual([
      buildNewMessagePush(token, conversationId),
      buildNewMessagePush("ExponentPushToken[bob-device]", conversationId),
    ]);
    expect(delivery).toEqual({
      mode: "sent",
      attempted: 2,
      accepted: 1,
      droppedTokens: ["ExponentPushToken[bob-device]"],
    });
  });

  it("retries once on a 5xx response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ status: "ok", id: "ticket-1" }] }));
    const delivery = await deliverExpoPushes({
      accessToken: "expo-access-token",
      messages: [buildNewMessagePush(token, conversationId)],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delivery.accepted).toBe(1);
  });

  it("registers from the client without message fields", async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const client = createPushClient({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          authorization: headers.get("authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        const path = String(url).replace("http://127.0.0.1:8787", "");
        if (path === "/push/register") return Response.json({ registered: true });
        if (path === "/push/unregister") return Response.json({ unregistered: true });
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const body = registrationBody({
      expoPushToken: token,
      platform: "ios",
      deviceId: conversationId,
    });
    expect(body).toEqual({ expoPushToken: token, platform: "ios", deviceId: conversationId });
    expect(JSON.stringify(body)).not.toContain(ciphertext);
    await expect(client.registerPushToken("session-token", body)).resolves.toEqual({ registered: true });
    await expect(client.unregisterPushToken("session-token", token)).resolves.toEqual({ unregistered: true });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8787/push/register",
      "http://127.0.0.1:8787/push/unregister",
    ]);
    expect(calls[0]?.authorization).toBe("Bearer session-token");
    expect(calls[0]?.body).toEqual(body);

    await expect(
      client.registerPushToken("session-token", { ...body, preview: "secret" } as typeof body),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it("reads only a conversation id from notification data", () => {
    expect(inboxConversationId({ conversationId, unread: true, preview: "hello", ciphertext })).toBe(
      conversationId,
    );
    expect(inboxConversationId({ conversationId, unread: "true" })).toBe(conversationId);
    expect(inboxConversationId({ conversationId, unread: false })).toBeNull();
    expect(inboxConversationId({ preview: "hello" })).toBeNull();
    const now = 1_700_000_000_000;
    expect(
      shouldOpenInboxFromLaunch({
        data: { conversationId, unread: true },
        notificationDate: now - 2_000,
        now,
      }),
    ).toBe(true);
    expect(
      shouldOpenInboxFromLaunch({
        data: { conversationId, unread: true, preview: "secret" },
        notificationDate: now - 60_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldOpenInboxFromLaunch({
        data: { preview: ciphertext },
        notificationDate: now,
        now,
      }),
    ).toBe(false);
    expect(registrationBody({ expoPushToken: token, platform: "android", deviceId: null })).toEqual({
      expoPushToken: token,
      platform: "android",
    });
    expect(
      serverDeviceIdFromRecord(
        JSON.stringify({ serverDeviceId: conversationId, identity: { dhPrivateKey: "secret" } }),
      ),
    ).toBe(conversationId);
    expect(serverDeviceIdFromRecord("{")).toBeNull();
  });
});
