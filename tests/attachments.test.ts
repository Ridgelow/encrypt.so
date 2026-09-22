import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deliverSealedAttachment, openAttachment } from "../src/e2ee/attachment";
import { decodeOpaqueEnvelope } from "../src/e2ee/envelope";
import { ensureDeviceKeys } from "../src/e2ee/provision";
import { DEVICE_KEY_RECORD_KEY, parseRecord, privateMaterial } from "../src/e2ee/record";
import { decryptFromPeer, encryptForPeer, ensureSessionWithUser } from "../src/e2ee/session";
import { createChunkedStore, type KeyValueStore } from "../src/e2ee/store";
import { createMessagingClient } from "../src/services/api";
import { createMockAuthClient, STUB_VERIFY_CODE } from "../src/services/api-mock";
import { ApiError } from "../src/services/errors";
import {
  dispatchAttachment,
  type AttachmentDeps,
  type AttachmentGrants,
} from "../workers/src/attachments";
import { HttpError } from "../workers/src/http";

const CIPHERTEXT_RE = /^[A-Za-z0-9+/_-]{4,49152}={0,2}$/;
const CONTENT_TYPE_RE = /^[\w!#$&^_.+-]{1,64}(?:\/[\w!#$&^_.+-]{1,64})?$/;

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return createChunkedStore({
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async deleteItem(key) {
      map.delete(key);
    },
  });
}

function bytesInclude(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  if (needle.length === 0 || needle.length > bytes.length) return false;
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}

function memoryBlobs(): AttachmentDeps["blobs"] & { snapshot(): Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      map.set(key, new Uint8Array(bytes));
    },
    async get(key) {
      const bytes = map.get(key);
      if (!bytes) return null;
      const copy = bytes.slice();
      return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
    },
    snapshot: () => map,
  };
}

function memoryGrants(): AttachmentGrants {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

function membershipDb(members: Set<string>): AttachmentDeps["db"] {
  return {
    prepare(query) {
      if (!query.includes("FROM memberships")) throw new Error(`unexpected query: ${query}`);
      return {
        bind(conversationId: unknown, userId: unknown) {
          return {
            async first<T>(): Promise<T | null> {
              if (typeof conversationId !== "string" || typeof userId !== "string") return null;
              return (members.has(`${conversationId}:${userId}`) ? { ok: 1 } : null) as T | null;
            },
          };
        },
      };
    },
  };
}

async function provisionUser(api: ReturnType<typeof createMockAuthClient>, phone: string, store: KeyValueStore) {
  const challenge = await api.startPhoneAuth(phone);
  const session = await api.verifyPhoneAuth(challenge.challengeId, STUB_VERIFY_CODE);
  await ensureDeviceKeys({
    store,
    session,
    api,
    apiOrigin: "http://127.0.0.1:8787",
    oneTimePreKeyCount: 3,
  });
  return session;
}

describe("encrypted attachments", () => {
  it("seals a file, stores only ciphertext, and opens it for the peer", async () => {
    const api = createMockAuthClient();
    const aliceStore = memoryStore();
    const bobStore = memoryStore();
    const alice = await provisionUser(api, "+15550100021", aliceStore);
    const bob = await provisionUser(api, "+15550100022", bobStore);
    await ensureSessionWithUser({
      store: aliceStore,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: bob.userId,
      getPrekeyBundle: (token, userId) => api.getPrekeyBundle(token, userId),
    });

    const conversationId = crypto.randomUUID();
    const members = new Set([`${conversationId}:${alice.userId}`, `${conversationId}:${bob.userId}`]);
    const blobs = memoryBlobs();
    const deps: AttachmentDeps = { db: membershipDb(members), blobs, grants: memoryGrants() };
    const tokens = new Map<string, string>([
      ["alice-token", alice.userId],
      ["bob-token", bob.userId],
      ["stranger-token", crypto.randomUUID()],
    ]);
    const authenticate = async (request: Request) => {
      const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
      if (!match) throw new HttpError(401, "missing session");
      const userId = tokens.get(match[1] ?? "");
      if (!userId) throw new HttpError(401, "invalid session");
      return userId;
    };

    const filename = "vacation-photo.jpg";
    const marker = "PLAINTEXT-FILE-BODY-SHOULD-NOT-UPLOAD";
    const plain = new TextEncoder().encode(`${marker}\nnot-the-ciphertext`);
    const posts: Array<Record<string, unknown>> = [];

    const delivered = await deliverSealedAttachment({
      bytes: plain,
      mime: "image/jpeg",
      name: `../secrets/${filename}`,
      clientId: "att-1",
      encrypt: (plaintext) =>
        encryptForPeer({
          store: aliceStore,
          localUserId: alice.userId,
          peerUserId: bob.userId,
          plaintext,
        }),
      async mint() {
        const response = await dispatchAttachment(
          new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments`, {
            method: "POST",
            headers: { authorization: "Bearer alice-token", "content-type": "application/json" },
            body: "{}",
          }),
          deps,
          authenticate,
        );
        expect(response?.status).toBe(201);
        const body = (await response!.json()) as { objectKey: string; uploadUrl: string };
        expect(body.uploadUrl).toContain(`/attachments/${body.objectKey}?grant=`);
        expect(JSON.stringify(body)).not.toContain(filename);
        expect(JSON.stringify(body)).not.toContain(marker);
        return { objectKey: body.objectKey, uploadUrl: body.uploadUrl };
      },
      async upload(uploadUrl, ciphertext) {
        const response = await dispatchAttachment(
          new Request(uploadUrl, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: ciphertext.slice(),
          }),
          deps,
          authenticate,
        );
        expect(response?.status).toBe(201);
        const stored = (await response!.json()) as { byteLength?: number; filename?: string };
        expect(stored.filename).toBeUndefined();
        expect(stored.byteLength).toBe(ciphertext.byteLength);
      },
      async post(body) {
        posts.push(body);
      },
    });

    expect(posts).toHaveLength(1);
    const posted = posts[0] ?? {};
    expect(Object.keys(posted).sort()).toEqual(["ciphertext", "clientId", "contentType", "senderDeviceId"]);
    expect(posted.contentType).toBe("attachment/v1");
    expect(posted.contentType).toMatch(CONTENT_TYPE_RE);
    expect(posted.ciphertext).toMatch(CIPHERTEXT_RE);
    expect(posted.clientId).toBe("att-1");
    expect(String(posted.ciphertext)).not.toContain(filename);
    expect(String(posted.ciphertext)).not.toContain(marker);

    const stored = blobs.snapshot().get(`${conversationId}/${delivered.objectKey}`);
    expect(stored).toBeTruthy();
    expect(bytesInclude(stored ?? new Uint8Array(), marker)).toBe(false);
    expect(bytesInclude(stored ?? new Uint8Array(), filename)).toBe(false);
    expect(Buffer.from(stored ?? new Uint8Array()).equals(Buffer.from(plain))).toBe(false);

    const aliceRecord = parseRecord((await aliceStore.getItem(DEVICE_KEY_RECORD_KEY)) as string);
    const bobRecord = parseRecord((await bobStore.getItem(DEVICE_KEY_RECORD_KEY)) as string);
    const secrets = [...privateMaterial(aliceRecord), ...privateMaterial(bobRecord)];
    const published = JSON.stringify(api.publicState());
    for (const secret of secrets) {
      expect(String(posted.ciphertext).includes(secret)).toBe(false);
      expect(bytesInclude(stored ?? new Uint8Array(), secret)).toBe(false);
      expect(published.includes(secret)).toBe(false);
    }

    const stranger = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments/${delivered.objectKey}`, {
        headers: { authorization: "Bearer stranger-token" },
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(stranger).toBeInstanceOf(HttpError);
    expect((stranger as HttpError).status).toBe(404);

    const envelope = decodeOpaqueEnvelope(String(posted.ciphertext));
    expect(envelope).not.toBeNull();
    const plaintext = await decryptFromPeer({
      store: bobStore,
      localUserId: bob.userId,
      envelope: envelope!,
    });
    const descriptor = JSON.parse(plaintext) as { key: string; name?: string; mime: string };
    expect(descriptor.name).toBe(filename);
    expect(descriptor.mime).toBe("image/jpeg");
    expect(String(posted.ciphertext).includes(descriptor.key)).toBe(false);
    expect(bytesInclude(stored ?? new Uint8Array(), descriptor.key)).toBe(false);

    const downloaded = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments/${delivered.objectKey}`, {
        headers: { authorization: "Bearer bob-token" },
      }),
      deps,
      authenticate,
    );
    expect(downloaded?.status).toBe(200);
    expect(downloaded?.headers.get("content-type")).toContain("application/octet-stream");
    const ciphertextBytes = new Uint8Array(await downloaded!.arrayBuffer());
    const opened = await openAttachment({ plaintext, ciphertextBytes });
    expect(Buffer.from(opened.bytes).equals(Buffer.from(plain))).toBe(true);
    expect(opened.name).toBe(filename);

    const tampered = ciphertextBytes.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(openAttachment({ plaintext, ciphertextBytes: tampered })).rejects.toThrow(/unreadable/i);

    const replay = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/attachments/${delivered.objectKey}?grant=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: ciphertextBytes.slice(),
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(HttpError);
    expect((replay as HttpError).status).toBe(401);
  });

  it("rejects plaintext fields and non-members", async () => {
    const conversationId = crypto.randomUUID();
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    const members = new Set([`${conversationId}:${alice}`, `${conversationId}:${bob}`]);
    const blobs = memoryBlobs();
    const deps: AttachmentDeps = { db: membershipDb(members), blobs, grants: memoryGrants(), maxBytes: 8 };
    const tokens = new Map<string, string>([
      ["alice", alice],
      ["stranger", stranger],
    ]);
    const authenticate = async (request: Request) => {
      const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
      if (!match) throw new HttpError(401, "missing session");
      const userId = tokens.get(match[1] ?? "");
      if (!userId) throw new HttpError(401, "invalid session");
      return userId;
    };

    const missing = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments/${crypto.randomUUID()}`),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(HttpError);
    expect((missing as HttpError).status).toBe(401);

    const named = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments`, {
        method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" },
        body: JSON.stringify({ filename: "vacation-photo.jpg", plaintext: "hello" }),
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(named).toBeInstanceOf(HttpError);
    expect((named as HttpError).status).toBe(400);
    expect((named as HttpError).message).toMatch(/plaintext/i);
    expect(blobs.snapshot().size).toBe(0);

    const outsider = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments`, {
        method: "POST",
        headers: { authorization: "Bearer stranger", "content-type": "application/json" },
        body: "{}",
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(outsider).toBeInstanceOf(HttpError);
    expect((outsider as HttpError).status).toBe(404);

    const minted = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${conversationId}/attachments`, {
        method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" },
        body: "{}",
      }),
      deps,
      authenticate,
    );
    expect(minted?.status).toBe(201);
    const grant = (await minted!.json()) as { objectKey: string; uploadUrl: string };

    const jsonBody = await dispatchAttachment(
      new Request(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "vacation-photo.jpg" }),
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(jsonBody).toBeInstanceOf(HttpError);
    expect((jsonBody as HttpError).status).toBe(400);
    expect(blobs.snapshot().size).toBe(0);

    const tooBig = await dispatchAttachment(
      new Request(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": "9" },
        body: new Uint8Array(9),
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(tooBig).toBeInstanceOf(HttpError);
    expect((tooBig as HttpError).status).toBe(413);
    expect(blobs.snapshot().size).toBe(0);

    const otherConversation = crypto.randomUUID();
    const crossed = await dispatchAttachment(
      new Request(`http://127.0.0.1:8787/conversations/${otherConversation}/attachments/${grant.objectKey}`, {
        headers: { authorization: "Bearer alice" },
      }),
      deps,
      authenticate,
    ).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(HttpError);
    expect((crossed as HttpError).status).toBe(404);
  });

  it("uploads ciphertext only to the API origin", async () => {
    const calls: string[] = [];
    const objectKey = "11111111-1111-4111-8111-111111111111";
    const grant = "ab".repeat(32);
    const client = createMessagingClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)} ${init?.body instanceof Blob ? "blob" : typeof init?.body}`);
        if (String(url).endsWith("/attachments") && init?.method === "POST") {
          expect(String(init.body)).toBe("{}");
          return Response.json(
            {
              objectKey,
              uploadUrl: `http://127.0.0.1:8787/attachments/${objectKey}?grant=${grant}`,
              expiresAt: Date.now() + 60_000,
            },
            { status: 201 },
          );
        }
        return Response.json({ objectKey, byteLength: 4 }, { status: 201 });
      },
    });

    const minted = await client.createAttachmentUpload("token", "22222222-2222-4222-8222-222222222222");
    await client.uploadAttachment(minted.uploadUrl, new Uint8Array([9, 8, 7, 6]));
    expect(calls[0]).toContain("POST http://127.0.0.1:8787/conversations/");
    expect(calls[1]).toContain(`PUT http://127.0.0.1:8787/attachments/${objectKey}`);
    expect(calls[1]).toContain("blob");
    await expect(
      client.uploadAttachment("https://evil.example/attachments/" + objectKey + "?grant=" + grant, new Uint8Array([1])),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it("mounts attachment dispatch on the worker", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../workers/src/index.ts"), "utf8");
    expect(source).toContain("dispatchAttachment");
    expect(source).toContain('binding = "ATTACHMENTS"') || expect(readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../workers/wrangler.toml"),
      "utf8",
    )).toContain('binding = "ATTACHMENTS"');
  });
});
