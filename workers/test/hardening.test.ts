import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_WS_PER_USER } from "../src/guard";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PEER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const CONVO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const PHONE = "+15550100901";
const CIPHERTEXT = "b3BhcXVlLWNpcGhlcnRleHQtYmxvYg==";

async function seed(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, phone, created_at) VALUES (?, ?, ?)")
    .bind(USER, PHONE, now)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, phone, created_at) VALUES (?, ?, ?)")
    .bind(PEER, "+15550100902", now)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO devices (id, user_id, device_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(DEVICE, USER, "primary", now)
    .run();
  const pair = [USER, PEER].sort().join(":");
  await env.DB.prepare("INSERT OR IGNORE INTO conversations (id, created_at, pair_key) VALUES (?, ?, ?)")
    .bind(CONVO, now, pair)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(CONVO, USER, now)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(CONVO, PEER, now)
    .run();
  await env.SESSIONS.put("session:harden-user", JSON.stringify({ userId: USER, createdAt: now }));
}

describe("worker guardrails", () => {
  it("rate limits phone starts and backs off a bad code", async () => {
    const phone = "+15550100911";
    let lastStatus = 0;
    for (let i = 0; i < 8; i++) {
      const response = await SELF.fetch("https://encrypt.so/auth/phone/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      lastStatus = response.status;
      expect(response.status).toBe(200);
      await response.json();
    }
    const limited = await SELF.fetch("https://encrypt.so/auth/phone/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    expect(lastStatus).toBe(200);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("slow down");
    expect(body.retryAfter).toBeGreaterThan(0);

    const started = await SELF.fetch("https://encrypt.so/auth/phone/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+15550100912" }),
    });
    expect(started.status).toBe(200);
    const { challengeId } = (await started.json()) as { challengeId: string };
    const rejected = await SELF.fetch("https://encrypt.so/auth/phone/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId, code: "000001" }),
    });
    expect(rejected.status).toBe(401);
    await rejected.json();
    const locked = await SELF.fetch("https://encrypt.so/auth/phone/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId, code: "000000" }),
    });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    await locked.json();
  });

  it("honors a phone blocklist key and an oversized envelope", async () => {
    await seed();
    await env.SESSIONS.put("block:phone:+15550100913", "1");
    const blocked = await SELF.fetch("https://encrypt.so/auth/phone/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+15550100913" }),
    });
    expect(blocked.status).toBe(403);
    await blocked.json();

    const huge = await SELF.fetch(`https://encrypt.so/conversations/${CONVO}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer harden-user", "content-type": "application/json" },
      body: JSON.stringify({ ciphertext: "A".repeat(49153), clientId: "too-big" }),
    });
    expect(huge.status).toBe(413);
    const hugeBody = (await huge.json()) as { error: string };
    expect(hugeBody.error).toBe("envelope too large");
    expect(JSON.stringify(hugeBody)).not.toMatch(/AAAA/);
  });

  it("deletes disappeared rows and rows past the server ceiling", async () => {
    await seed();
    const now = Date.now();
    const fresh = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const goneTimer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const goneCeiling = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fresh, CONVO, DEVICE, CIPHERTEXT, "application/octet-stream", now, now + 60_000, "fresh")
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(goneTimer, CONVO, DEVICE, CIPHERTEXT, "application/octet-stream", now, now - 1_000, "gone-timer")
      .run();
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_device_id, ciphertext, content_type, created_at, expire_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(goneCeiling, CONVO, DEVICE, CIPHERTEXT, "application/octet-stream", now - 40 * 24 * 60 * 60 * 1000, null, "gone-ceiling")
      .run();

    const listed = await SELF.fetch(`https://encrypt.so/conversations/${CONVO}/messages`, {
      headers: { authorization: "Bearer harden-user" },
    });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { messages: Array<{ id: string; ciphertext: string }> };
    expect(page.messages.map((message) => message.id)).toEqual([fresh]);
    expect(page.messages[0]?.ciphertext).toBe(CIPHERTEXT);
    const left = await env.DB.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id")
      .bind(CONVO)
      .all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual([fresh]);
  });

  it("drops an attachment pointer after its deadline", async () => {
    await seed();
    const minted = await SELF.fetch(`https://encrypt.so/conversations/${CONVO}/attachments`, {
      method: "POST",
      headers: { authorization: "Bearer harden-user", "content-type": "application/json" },
      body: JSON.stringify({ expireAt: Date.now() + 60_000 }),
    });
    expect(minted.status).toBe(201);
    const grant = (await minted.json()) as { objectKey: string; uploadUrl: string };
    const upload = await SELF.fetch(grant.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(upload.status).toBe(201);
    await upload.json();

    await env.DB.prepare("UPDATE attachment_objects SET expire_at = ? WHERE object_key = ?")
      .bind(Date.now() - 1_000, grant.objectKey)
      .run();
    const download = await SELF.fetch(
      `https://encrypt.so/conversations/${CONVO}/attachments/${grant.objectKey}`,
      { headers: { authorization: "Bearer harden-user" } },
    );
    expect(download.status).toBe(404);
    await download.text();
    const blob = await env.ATTACHMENTS.get(`${CONVO}/${grant.objectKey}`);
    expect(blob).toBeNull();
  });

  it("caps concurrent sockets for one user in a conversation", async () => {
    await seed();
    const cap = Number(env.MAX_WS_PER_USER) || DEFAULT_MAX_WS_PER_USER;
    const open: WebSocket[] = [];
    try {
      for (let i = 0; i < cap; i++) {
        const response = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${CONVO}`, {
          headers: { Upgrade: "websocket", Authorization: "Bearer harden-user" },
        });
        expect(response.status).toBe(101);
        const ws = response.webSocket;
        if (!ws) throw new Error("missing websocket");
        ws.accept();
        open.push(ws);
      }
      const rejected = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${CONVO}`, {
        headers: { Upgrade: "websocket", Authorization: "Bearer harden-user" },
      });
      expect(rejected.status).toBe(429);
      expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
      const body = (await rejected.json()) as { error: string };
      expect(body.error).toBe("too many connections");
      expect(rejected.webSocket).toBeNull();
    } finally {
      for (const ws of open) ws.close(1000, "done");
    }
  });
});
