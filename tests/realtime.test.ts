import { describe, expect, it, vi } from "vitest";
import type { OpaqueEnvelope } from "@/e2ee";
import type { CiphertextMessage, PostMessageInput } from "@/services/api";
import { envelopeToCiphertext, readOpaqueCiphertext } from "@/services/ciphertext";
import { createMessageCache, type MessageCache } from "@/services/messageCache";
import { liveChatEnabled, openLiveChat, type LiveThreadMessage } from "@/services/liveChat";
import {
  decodeOpaqueEnvelope,
  encodeOpaqueEnvelope,
  realtimeWebSocketUrl,
  type RealtimeTransport,
  type RealtimeTransportFactory,
} from "@/services/realtime";
import type { KeyValueStore } from "@/e2ee/store";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const CONVO = "44444444-4444-4444-8444-444444444444";

const envelope: OpaqueEnvelope = {
  version: 1,
  senderUserId: ALICE,
  senderDeviceId: DEVICE,
  recipientUserId: BOB,
  recipientDeviceId: "55555555-5555-4555-8555-555555555555",
  ciphertext: "Y2lwaGVydGV4dA==",
};

class MockSocket implements RealtimeTransport {
  static instances: MockSocket[] = [];
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    _protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; clientId?: string; conversationId?: string };
    if (frame.type === "message") {
      this.onmessage?.({
        data: JSON.stringify({
          type: "ack",
          conversationId: frame.conversationId,
          clientId: frame.clientId ?? null,
          id: "server-msg",
        }),
      });
    }
  }

  close(): void {
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function memoryStore(): KeyValueStore {
  const raw = new Map<string, string>();
  return {
    async getItem(key) {
      return raw.get(key) ?? null;
    },
    async setItem(key, value) {
      raw.set(key, value);
    },
    async deleteItem(key) {
      raw.delete(key);
    },
  };
}

function messagingMock(handlers?: {
  list?: CiphertextMessage[];
  onPost?: (body: PostMessageInput) => void;
}) {
  const posts: PostMessageInput[] = [];
  return {
    posts,
    client: {
      async createConversation() {
        return {
          id: CONVO,
          createdAt: 1,
          members: [
            { userId: ALICE, joinedAt: 1 },
            { userId: BOB, joinedAt: 1 },
          ],
        };
      },
      async listMessages() {
        return { messages: handlers?.list ?? [], nextCursor: null };
      },
      async postMessage(_token: string, _conversationId: string, body: PostMessageInput): Promise<CiphertextMessage> {
        posts.push(body);
        handlers?.onPost?.(body);
        return {
          id: "server-msg",
          conversationId: CONVO,
          senderDeviceId: DEVICE,
          ciphertext: body.ciphertext,
          contentType: body.contentType ?? "application/octet-stream",
          createdAt: 2,
          expireAt: body.expireAt ?? null,
          clientId: body.clientId ?? null,
        };
      },
    },
  };
}

async function startChat(options?: {
  list?: CiphertextMessage[];
  cache?: MessageCache | null;
  decrypt?: (envelope: OpaqueEnvelope) => Promise<string>;
  onMessage?: (message: LiveThreadMessage) => void;
}) {
  MockSocket.instances = [];
  const messaging = messagingMock({ list: options?.list });
  const incoming: LiveThreadMessage[] = [];
  const chat = await openLiveChat({
    httpBase: "http://127.0.0.1:8787/",
    sessionToken: "token-1",
    localUserId: ALICE,
    peerUserId: BOB,
    messaging: messaging.client,
    decrypt: options?.decrypt ?? (async () => "decrypted"),
    cache: options?.cache === undefined ? createMessageCache(memoryStore()) : options.cache,
    factory: MockSocket as unknown as RealtimeTransportFactory,
    onMessage(message) {
      incoming.push(message);
      options?.onMessage?.(message);
    },
  });
  const socket = MockSocket.instances[0];
  if (!socket) throw new Error("socket was not opened");
  return { chat, socket, messaging, incoming };
}

describe("realtime client", () => {
  it("builds a ws url and keeps mock chats offline", () => {
    expect(realtimeWebSocketUrl("https://api.encrypt.so", CONVO)).toBe(
      `wss://api.encrypt.so/realtime?conversationId=${CONVO}`,
    );
    expect(realtimeWebSocketUrl("http://127.0.0.1:8787/", CONVO)).toBe(
      `ws://127.0.0.1:8787/realtime?conversationId=${CONVO}`,
    );
    expect(
      liveChatEnabled({ peerUserId: null, isGroup: false, apiConfigured: true, hasSession: true }),
    ).toBe(false);
    expect(
      liveChatEnabled({ peerUserId: BOB, isGroup: true, apiConfigured: true, hasSession: true }),
    ).toBe(false);
    expect(
      liveChatEnabled({ peerUserId: BOB, isGroup: false, apiConfigured: false, hasSession: true }),
    ).toBe(false);
    expect(
      liveChatEnabled({ peerUserId: BOB, isGroup: false, apiConfigured: true, hasSession: false }),
    ).toBe(false);
    expect(
      liveChatEnabled({ peerUserId: BOB, isGroup: false, apiConfigured: true, hasSession: true }),
    ).toBe(true);
  });

  it("connects with the session bearer token and subscribes", async () => {
    const { socket } = await startChat();
    expect(socket.url).toBe(`ws://127.0.0.1:8787/realtime?conversationId=${CONVO}`);
    expect(socket.options?.headers).toEqual({ Authorization: "Bearer token-1" });
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({ type: "subscribe", conversationId: CONVO });
  });

  it("sends an opaque envelope and posts the same ciphertext", async () => {
    const cache = createMessageCache(memoryStore());
    const { chat, socket, messaging } = await startChat({ cache });
    socket.open();
    socket.receive({ type: "subscribed", conversationId: CONVO });

    await chat.publish(envelope, "hello bob");

    const frame = JSON.parse(socket.sent[1] ?? "") as Record<string, unknown>;
    expect(frame.type).toBe("message");
    expect(frame.conversationId).toBe(CONVO);
    expect(frame).not.toHaveProperty("plaintext");
    expect(frame).not.toHaveProperty("text");
    expect(frame).not.toHaveProperty("body");
    expect(frame).not.toHaveProperty("message");
    expect(JSON.stringify(frame)).not.toContain("hello bob");
    expect(decodeOpaqueEnvelope(String(frame.ciphertext))).toEqual(envelope);
    expect(messaging.posts).toHaveLength(1);
    expect(messaging.posts[0]?.ciphertext).toBe(frame.ciphertext);
    expect(messaging.posts[0]?.senderDeviceId).toBe(DEVICE);
    expect(messaging.posts[0]).not.toHaveProperty("plaintext");

    const cached = await cache.list(CONVO);
    expect(cached).toEqual([
      expect.objectContaining({ plaintext: "hello bob", from: "me", conversationId: CONVO }),
    ]);
  });

  it("decrypts a received envelope into the thread and the cache", async () => {
    const cache = createMessageCache(memoryStore());
    const decrypt = vi.fn(async () => "hello from bob");
    const { socket, incoming } = await startChat({ cache, decrypt });
    socket.open();
    socket.receive({ type: "subscribed", conversationId: CONVO });

    const inbound = encodeOpaqueEnvelope({
      ...envelope,
      senderUserId: BOB,
      senderDeviceId: "66666666-6666-4666-8666-666666666666",
      recipientUserId: ALICE,
      ciphertext: "aW5ib3VuZA==",
    });
    socket.receive({
      type: "message",
      conversationId: CONVO,
      ciphertext: inbound,
      contentType: "application/octet-stream",
      clientId: "bob-1",
      senderDeviceId: "66666666-6666-4666-8666-666666666666",
      expireAt: null,
      fromUserId: BOB,
      id: "server-bob",
      createdAt: 40,
    });

    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(decrypt).toHaveBeenCalledOnce();
    expect(incoming[0]).toMatchObject({ id: "bob-1", from: "them", text: "hello from bob" });
    expect(await cache.list(CONVO)).toEqual([
      expect.objectContaining({ id: "bob-1", plaintext: "hello from bob", from: "them" }),
    ]);
  });

  it("restores history from ciphertext rows and does not decrypt our own sends", async () => {
    const cache = createMessageCache(memoryStore());
    await cache.save({
      id: "mine-1",
      conversationId: CONVO,
      plaintext: "sent earlier",
      createdAt: 5,
      from: "me",
    });
    const mine = encodeOpaqueEnvelope(envelope);
    const theirs = encodeOpaqueEnvelope({
      ...envelope,
      senderUserId: BOB,
      recipientUserId: ALICE,
      ciphertext: "dGhlaXJz",
    });
    const decrypt = vi.fn(async () => "from the server");
    const { chat } = await startChat({
      cache,
      decrypt,
      list: [
        {
          id: "row-mine",
          conversationId: CONVO,
          senderDeviceId: DEVICE,
          ciphertext: mine,
          contentType: "application/octet-stream",
          createdAt: 5,
          expireAt: null,
          clientId: "mine-1",
        },
        {
          id: "row-theirs",
          conversationId: CONVO,
          senderDeviceId: "66666666-6666-4666-8666-666666666666",
          ciphertext: theirs,
          contentType: "application/octet-stream",
          createdAt: 6,
          expireAt: null,
          clientId: "bob-old",
        },
      ],
    });

    expect(decrypt).toHaveBeenCalledOnce();
    expect(chat.history.map((message) => ({ id: message.id, from: message.from, text: message.text }))).toEqual([
      { id: "mine-1", from: "me", text: "sent earlier" },
      { id: "bob-old", from: "them", text: "from the server" },
    ]);
  });

  it("forwards expireAt on the socket and the ciphertext post", async () => {
    const cache = createMessageCache(memoryStore());
    const { chat, socket, messaging } = await startChat({ cache });
    socket.open();
    socket.receive({ type: "subscribed", conversationId: CONVO });
    const expireAt = Date.now() + 60_000;

    await chat.publish(envelope, "hello bob", { expireAt });

    const frame = JSON.parse(socket.sent[1] ?? "") as Record<string, unknown>;
    expect(frame.expireAt).toBe(expireAt);
    expect(frame).not.toHaveProperty("plaintext");
    expect(JSON.stringify(frame)).not.toContain("hello bob");
    expect(messaging.posts[0]?.expireAt).toBe(expireAt);
    expect(messaging.posts[0]).not.toHaveProperty("plaintext");
    expect(await cache.list(CONVO)).toEqual([
      expect.objectContaining({ plaintext: "hello bob", from: "me", expireAt }),
    ]);
  });

  it("skips expired history and reads both ciphertext encodings", async () => {
    const theirs = encodeOpaqueEnvelope({
      ...envelope,
      senderUserId: BOB,
      recipientUserId: ALICE,
      ciphertext: "dGhlaXJz",
    });
    const sdkCiphertext = envelopeToCiphertext({
      ...envelope,
      senderUserId: BOB,
      recipientUserId: ALICE,
      ciphertext: "c2RrLWVudmVsb3Bl",
    });
    expect(readOpaqueCiphertext(theirs)?.senderUserId).toBe(BOB);
    expect(readOpaqueCiphertext(sdkCiphertext)?.ciphertext).toBe("c2RrLWVudmVsb3Bl");
    const decrypt = vi.fn(async () => "still here");
    const expireAt = Date.now() + 60_000;
    const { chat } = await startChat({
      decrypt,
      list: [
        {
          id: "row-gone",
          conversationId: CONVO,
          senderDeviceId: "66666666-6666-4666-8666-666666666666",
          ciphertext: theirs,
          contentType: "application/octet-stream",
          createdAt: 1,
          expireAt: 1,
          clientId: "gone",
        },
        {
          id: "row-sdk",
          conversationId: CONVO,
          senderDeviceId: "66666666-6666-4666-8666-666666666666",
          ciphertext: sdkCiphertext,
          contentType: "application/vnd.encrypt.envelope",
          createdAt: 6,
          expireAt,
          clientId: "sdk-1",
        },
      ],
    });

    expect(decrypt).toHaveBeenCalledOnce();
    expect(chat.history.map((message) => ({ id: message.id, text: message.text, expireAt: message.expireAt }))).toEqual([
      { id: "sdk-1", text: "still here", expireAt },
    ]);
  });
});
