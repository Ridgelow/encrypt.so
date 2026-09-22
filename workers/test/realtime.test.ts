import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const CONVO = "55555555-5555-4555-8555-555555555555";
const CIPHERTEXT = "b3BhcXVlLWNpcGhlcnRleHQtYmxvYg==";

beforeAll(async () => {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").bind(ALICE, "+15550100001", now).run();
  await env.DB.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").bind(BOB, "+15550100002", now).run();
  await env.DB.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").bind(CHARLIE, "+15550100003", now).run();
  await env.DB.prepare("INSERT INTO devices (id, user_id, device_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(DEVICE, ALICE, "primary", now)
    .run();
  const pair = [ALICE, BOB].sort().join(":");
  await env.DB.prepare("INSERT INTO conversations (id, created_at, pair_key) VALUES (?, ?, ?)")
    .bind(CONVO, now, pair)
    .run();
  await env.DB.prepare("INSERT INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(CONVO, ALICE, now)
    .run();
  await env.DB.prepare("INSERT INTO memberships (conversation_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(CONVO, BOB, now)
    .run();
  await env.SESSIONS.put(`session:alice`, JSON.stringify({ userId: ALICE, createdAt: now }));
  await env.SESSIONS.put(`session:bob`, JSON.stringify({ userId: BOB, createdAt: now }));
  await env.SESSIONS.put(`session:charlie`, JSON.stringify({ userId: CHARLIE, createdAt: now }));
});

type Frame = Record<string, unknown>;

function collect(ws: WebSocket): { next: () => Promise<Frame>; received: () => Frame[] } {
  const queue: Frame[] = [];
  const received: Frame[] = [];
  let waiter: ((frame: Frame) => void) | null = null;
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    received.push(frame);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(frame);
    } else {
      queue.push(frame);
    }
  });
  return {
    received: () => received,
    next() {
      const existing = queue.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
  };
}

async function subscribe(token: string, conversationId = CONVO): Promise<{ ws: WebSocket; inbox: ReturnType<typeof collect> }> {
  const response = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${conversationId}`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("missing websocket");
  const inbox = collect(ws);
  ws.accept();
  ws.send(JSON.stringify({ type: "subscribe", conversationId }));
  const first = await inbox.next();
  if (first.type === "ready") {
    expect((await inbox.next()).type).toBe("subscribed");
  } else {
    expect(first.type).toBe("subscribed");
  }
  return { ws, inbox };
}

describe("realtime websocket", () => {
  it("rejects an upgrade without a session", async () => {
    const response = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${CONVO}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("missing session");
    expect(response.webSocket).toBeNull();
  });

  it("rejects a bad session token", async () => {
    const response = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${CONVO}`, {
      headers: { Upgrade: "websocket", Authorization: "Bearer nope" },
    });
    expect(response.status).toBe(401);
    await response.text();
  });

  it("rejects a non-member before opening a socket", async () => {
    const response = await SELF.fetch(`https://encrypt.so/realtime?conversationId=${CONVO}`, {
      headers: { Upgrade: "websocket", Authorization: "Bearer charlie" },
    });
    expect(response.status).toBe(404);
    await response.text();
  });

  it("fans an opaque envelope out to other members and stores it", async () => {
    const alice = await subscribe("alice");
    const bob = await subscribe("bob");
    const aliceOther = await subscribe("alice");

    alice.ws.send(
      JSON.stringify({
        type: "message",
        conversationId: CONVO,
        ciphertext: CIPHERTEXT,
        contentType: "application/octet-stream",
        clientId: "msg-1",
        senderDeviceId: DEVICE,
      }),
    );

    const ack = await alice.inbox.next();
    expect(ack.type).toBe("ack");
    expect(ack.clientId).toBe("msg-1");
    expect(JSON.stringify(ack)).not.toMatch(/plaintext|hello/);

    const toBob = await bob.inbox.next();
    const toOther = await aliceOther.inbox.next();
    expect(toBob).toMatchObject({
      type: "message",
      conversationId: CONVO,
      ciphertext: CIPHERTEXT,
      fromUserId: ALICE,
      clientId: "msg-1",
    });
    expect(toBob).not.toHaveProperty("plaintext");
    expect(toBob).not.toHaveProperty("text");
    expect(toBob).not.toHaveProperty("body");
    expect(toOther).toMatchObject({ type: "message", ciphertext: CIPHERTEXT, fromUserId: ALICE });
    expect(alice.inbox.received().some((frame) => frame.type === "message")).toBe(false);

    const row = await env.DB.prepare(
      "SELECT ciphertext, content_type, client_id, sender_device_id FROM messages WHERE conversation_id = ?",
    )
      .bind(CONVO)
      .first<{ ciphertext: string; content_type: string; client_id: string; sender_device_id: string }>();
    expect(row).toEqual({
      ciphertext: CIPHERTEXT,
      content_type: "application/octet-stream",
      client_id: "msg-1",
      sender_device_id: DEVICE,
    });

    alice.ws.close(1000, "done");
    bob.ws.close(1000, "done");
    aliceOther.ws.close(1000, "done");
  });

  it("refuses plaintext fields and does not fan them out or store them", async () => {
    const alice = await subscribe("alice");
    const bob = await subscribe("bob");
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .bind(CONVO)
      .first<{ n: number }>();

    alice.ws.send(
      JSON.stringify({
        type: "message",
        conversationId: CONVO,
        ciphertext: CIPHERTEXT,
        clientId: "msg-plain",
        text: "hello bob",
        body: "hello bob",
      }),
    );

    const error = await alice.inbox.next();
    expect(error).toMatchObject({ type: "error", error: "plaintext is not accepted" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bob.inbox.received().some((frame) => frame.type === "message")).toBe(false);

    alice.ws.send(
      JSON.stringify({
        type: "message",
        conversationId: CONVO,
        ciphertext: CIPHERTEXT,
        clientId: "msg-private",
        privateKey: "secret",
      }),
    );
    const privateError = await alice.inbox.next();
    expect(privateError).toMatchObject({ type: "error", error: "private keys are not accepted" });

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .bind(CONVO)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    alice.ws.close(1000, "done");
    bob.ws.close(1000, "done");
  });
});
