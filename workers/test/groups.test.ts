import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ALICE = "aaaaaaa1-1111-4111-8111-111111111111";
const BOB = "bbbbbbb2-2222-4222-8222-222222222222";
const CAROL = "ccccccc3-3333-4333-8333-333333333333";
const DAVE = "ddddddd4-4444-4444-8444-444444444444";
const EVE = "eeeeeee5-5555-4555-8555-555555555555";
const DEVICE = "fffffff6-6666-4666-8666-666666666666";
const CIPHERTEXT = "b3BhcXVlLWdyb3VwLWNpcGhlcnRleHQ=";

beforeAll(async () => {
  const now = Date.now();
  for (const [id, phone] of [
    [ALICE, "+15550111001"],
    [BOB, "+15550111002"],
    [CAROL, "+15550111003"],
    [DAVE, "+15550111004"],
    [EVE, "+15550111005"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").bind(id, phone, now).run();
    await env.SESSIONS.put(`session:${id}`, JSON.stringify({ userId: id, createdAt: now }));
  }
  await env.DB.prepare("INSERT INTO devices (id, user_id, device_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(DEVICE, ALICE, "primary", now)
    .run();
});

function auth(userId: string): HeadersInit {
  return { authorization: `Bearer ${userId}`, "content-type": "application/json" };
}

describe("group conversations", () => {
  it("creates a group, lists members, adds one, and fans one ciphertext to every member", async () => {
    const created = await SELF.fetch("https://encrypt.so/conversations", {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ title: "Design Crit", memberUserIds: [BOB, CAROL] }),
    });
    expect(created.status).toBe(201);
    const group = (await created.json()) as {
      id: string;
      kind: string;
      title: string;
      members: Array<{ userId: string }>;
    };
    expect(group.kind).toBe("group");
    expect(group.title).toBe("Design Crit");
    expect(group.members.map((member) => member.userId).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(group).not.toHaveProperty("plaintext");
    expect(JSON.stringify(group)).not.toMatch(/private/i);

    const members = await SELF.fetch(`https://encrypt.so/conversations/${group.id}/members`, {
      headers: { authorization: `Bearer ${BOB}` },
    });
    expect(members.status).toBe(200);
    const listed = (await members.json()) as { members: Array<{ userId: string }> };
    expect(listed.members).toHaveLength(3);

    const outsider = await SELF.fetch(`https://encrypt.so/conversations/${group.id}/members`, {
      headers: { authorization: `Bearer ${EVE}` },
    });
    expect(outsider.status).toBe(404);
    await outsider.text();

    const added = await SELF.fetch(`https://encrypt.so/conversations/${group.id}/members`, {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ userId: DAVE }),
    });
    expect(added.status).toBe(200);
    const withDave = (await added.json()) as { members: Array<{ userId: string }> };
    expect(withDave.members.map((member) => member.userId)).toContain(DAVE);

    const posted = await SELF.fetch(`https://encrypt.so/conversations/${group.id}/messages`, {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({
        ciphertext: CIPHERTEXT,
        contentType: "application/vnd.encrypt.sender-key",
        clientId: "group-msg-1",
        senderDeviceId: DEVICE,
      }),
    });
    expect(posted.status).toBe(201);
    const page = await SELF.fetch(`https://encrypt.so/conversations/${group.id}/messages`, {
      headers: { authorization: `Bearer ${CAROL}` },
    });
    const body = (await page.json()) as { messages: Array<{ ciphertext: string }> };
    expect(body.messages[0]?.ciphertext).toBe(CIPHERTEXT);
    expect(body.messages[0]).not.toHaveProperty("plaintext");
    expect(JSON.stringify(body)).not.toMatch(/privateKey|hello group/i);

    const aliceSocket = await subscribe(ALICE, group.id);
    const bobSocket = await subscribe(BOB, group.id);
    const carolSocket = await subscribe(CAROL, group.id);
    aliceSocket.ws.send(
      JSON.stringify({
        type: "message",
        conversationId: group.id,
        ciphertext: CIPHERTEXT,
        contentType: "application/vnd.encrypt.sender-key",
        clientId: "group-live-1",
        senderDeviceId: DEVICE,
      }),
    );
    expect((await aliceSocket.inbox.next()).type).toBe("ack");
    const toBob = await bobSocket.inbox.next();
    const toCarol = await carolSocket.inbox.next();
    expect(toBob).toMatchObject({ type: "message", ciphertext: CIPHERTEXT, fromUserId: ALICE });
    expect(toCarol).toMatchObject({ type: "message", ciphertext: CIPHERTEXT, fromUserId: ALICE });
    expect(toBob).not.toHaveProperty("plaintext");
    expect(aliceSocket.inbox.received().some((frame) => frame.type === "message")).toBe(false);
    aliceSocket.ws.close(1000, "done");
    bobSocket.ws.close(1000, "done");
    carolSocket.ws.close(1000, "done");
  });

  it("rejects a one-member group, a private field, and adding someone to a 1:1 pair", async () => {
    const tooSmall = await SELF.fetch("https://encrypt.so/conversations", {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ title: "Nope", memberUserIds: [BOB] }),
    });
    expect(tooSmall.status).toBe(400);
    await tooSmall.text();

    const leaked = await SELF.fetch("https://encrypt.so/conversations", {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ title: "Nope", memberUserIds: [BOB, CAROL], privateKey: "nope" }),
    });
    expect(leaked.status).toBe(400);
    await leaked.text();

    const direct = await SELF.fetch("https://encrypt.so/conversations", {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ peerUserId: BOB }),
    });
    expect(direct.status).toBe(201);
    const pair = (await direct.json()) as { id: string; kind: string };
    expect(pair.kind).toBe("direct");
    const added = await SELF.fetch(`https://encrypt.so/conversations/${pair.id}/members`, {
      method: "POST",
      headers: auth(ALICE),
      body: JSON.stringify({ userId: CAROL }),
    });
    expect(added.status).toBe(400);
    await added.text();
  });
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

async function subscribe(token: string, conversationId: string): Promise<{ ws: WebSocket; inbox: ReturnType<typeof collect> }> {
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
