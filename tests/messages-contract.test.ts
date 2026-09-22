import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMessagingClient, type PostMessageInput } from "../src/services/api";
import { ApiError } from "../src/services/errors";

const ciphertext = "b3BhcXVlLWNpcGhlcnRleHQtYmxvYg==";

describe("ciphertext persistence contract", () => {
  it("migration stores ciphertext and has no plaintext column", () => {
    const sql = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../workers/migrations/0002_ciphertext.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE conversations/);
    expect(sql).toMatch(/CREATE TABLE memberships/);
    expect(sql).toMatch(/CREATE TABLE messages/);
    expect(sql).toMatch(/ciphertext TEXT NOT NULL/);
    expect(sql).toMatch(/sender_device_id TEXT NOT NULL/);
    expect(sql).toMatch(/content_type TEXT NOT NULL/);
    expect(sql).toMatch(/expire_at INTEGER/);
    const tables = sql
      .split(";")
      .map((statement) => statement.replace(/--[^\n]*/g, ""))
      .join(";");
    expect(tables).not.toMatch(/\b(plaintext|plain_text|body|message_text)\b/i);
  });

  it("live client posts ciphertext and pages with cursor and limit", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const client = createMessagingClient({
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        const raw = init?.body ? String(init.body) : "";
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          body: raw ? (JSON.parse(raw) as unknown) : null,
        });
        const path = String(url).replace("http://127.0.0.1:8787", "");
        if (path === "/conversations" && init?.method === "POST") {
          return Response.json(
            {
              id: "11111111-1111-4111-8111-111111111111",
              createdAt: 10,
              members: [
                { userId: "alice", joinedAt: 10 },
                { userId: "bob", joinedAt: 10 },
              ],
            },
            { status: 201 },
          );
        }
        if (path === "/conversations") {
          return Response.json({ conversations: [] });
        }
        if (path.endsWith("/messages") && init?.method === "POST") {
          return Response.json(
            {
              id: "22222222-2222-4222-8222-222222222222",
              conversationId: "11111111-1111-4111-8111-111111111111",
              senderDeviceId: "device-1",
              ciphertext,
              contentType: "application/octet-stream",
              createdAt: 11,
              expireAt: null,
              clientId: "msg-1",
            },
            { status: 201 },
          );
        }
        if (path.includes("/messages?")) {
          return Response.json({ messages: [], nextCursor: null });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const conversation = await client.createConversation("token-1", "bob");
    expect(conversation.id).toBe("11111111-1111-4111-8111-111111111111");
    await client.listConversations("token-1");
    const posted = await client.postMessage("token-1", conversation.id, {
      ciphertext,
      contentType: "application/octet-stream",
      clientId: "msg-1",
    });
    expect(posted.ciphertext).toBe(ciphertext);
    expect(posted).not.toHaveProperty("plaintext");
    await client.listMessages("token-1", conversation.id, { cursor: posted.id, limit: 20 });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8787/conversations",
      "GET http://127.0.0.1:8787/conversations",
      `POST http://127.0.0.1:8787/conversations/${conversation.id}/messages`,
      `GET http://127.0.0.1:8787/conversations/${conversation.id}/messages?cursor=${posted.id}&limit=20`,
    ]);
    expect(calls[0]?.body).toEqual({ peerUserId: "bob" });
    expect(calls[0]?.authorization).toBe("Bearer token-1");
    expect(calls[2]?.body).toEqual({
      ciphertext,
      contentType: "application/octet-stream",
      clientId: "msg-1",
    });

    calls.length = 0;
    await expect(
      client.postMessage("token-1", conversation.id, {
        ciphertext,
        plaintext: "hello",
      } as PostMessageInput),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });
});
