import { describe, expect, it } from "vitest";
import { GroupMessageError } from "../src/e2ee/errors";
import {
  acceptGroupDistribution,
  commitGroupDistribution,
  decryptGroupPlaintext,
  encryptGroupPlaintext,
  prepareGroupDistributions,
} from "../src/e2ee/group";
import { SENDER_KEY_FILE } from "../src/e2ee/group-store";
import { decodeGroupDistribution, decodeGroupSender } from "../src/e2ee/group-wire";
import { ensureDeviceKeys } from "../src/e2ee/provision";
import { ensureSessionWithUser } from "../src/e2ee/session";
import { createChunkedStore, type KeyValueStore } from "../src/e2ee/store";
import { createMessagingClient } from "../src/services/api";
import { createMockAuthClient, STUB_VERIFY_CODE } from "../src/services/api-mock";
import { LOCAL_PROTOCOL_DEVICE_ID } from "../src/e2ee/session";

const GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function chainKeyFrom(raw: string | null): string {
  const chainKey = (JSON.parse(raw ?? "") as { records: Array<{ states: Array<{ chainKey: string }> }> }).records[0]
    ?.states[0]?.chainKey;
  if (!chainKey) throw new Error("missing sender key");
  return chainKey;
}

function fieldNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) fieldNames(item, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      fieldNames(child, found);
    }
  }
  return found;
}

async function provisionUser(api: ReturnType<typeof createMockAuthClient>, phone: string, store: KeyValueStore) {
  const challenge = await api.startPhoneAuth(phone);
  const session = await api.verifyPhoneAuth(challenge.challengeId, STUB_VERIFY_CODE);
  await ensureDeviceKeys({
    store,
    session,
    api,
    apiOrigin: "http://127.0.0.1:8787",
    oneTimePreKeyCount: 4,
  });
  return session;
}

describe("sender keys", () => {
  it("distributes one sender key to Alice, Bob, and Carol and round-trips group ciphertext", async () => {
    const api = createMockAuthClient();
    const aliceStore = memoryStore();
    const bobStore = memoryStore();
    const carolStore = memoryStore();
    const alice = await provisionUser(api, "+15550100021", aliceStore);
    const bob = await provisionUser(api, "+15550100022", bobStore);
    const carol = await provisionUser(api, "+15550100023", carolStore);
    const members = [alice.userId, bob.userId, carol.userId];

    await ensureSessionWithUser({
      store: aliceStore,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: bob.userId,
      getPrekeyBundle: (token, userId) => api.getPrekeyBundle(token, userId),
    });
    await ensureSessionWithUser({
      store: aliceStore,
      localUserId: alice.userId,
      sessionToken: alice.sessionToken,
      peerUserId: carol.userId,
      getPrekeyBundle: (token, userId) => api.getPrekeyBundle(token, userId),
    });

    const prepared = await prepareGroupDistributions({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      memberUserIds: members,
    });
    expect(prepared.envelopes).toHaveLength(2);
    const toBob = prepared.envelopes.find((envelope) => envelope.recipientUserId === bob.userId);
    const toCarol = prepared.envelopes.find((envelope) => envelope.recipientUserId === carol.userId);
    expect(toBob).toBeTruthy();
    expect(toCarol).toBeTruthy();
    await commitGroupDistribution({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      senderKeyId: prepared.senderKeyId,
      memberUserIds: members,
    });

    const again = await prepareGroupDistributions({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      memberUserIds: members,
    });
    expect(again.envelopes).toHaveLength(0);
    expect(again.senderKeyId).toBe(prepared.senderKeyId);

    await acceptGroupDistribution({
      store: bobStore,
      localUserId: bob.userId,
      groupId: GROUP,
      protocolDeviceId: LOCAL_PROTOCOL_DEVICE_ID,
      envelope: toBob!,
    });
    await acceptGroupDistribution({
      store: carolStore,
      localUserId: carol.userId,
      groupId: GROUP,
      protocolDeviceId: LOCAL_PROTOCOL_DEVICE_ID,
      envelope: toCarol!,
    });
    await acceptGroupDistribution({
      store: bobStore,
      localUserId: bob.userId,
      groupId: GROUP,
      protocolDeviceId: LOCAL_PROTOCOL_DEVICE_ID,
      envelope: toBob!,
    });

    const bobChain = chainKeyFrom(await bobStore.getItem(SENDER_KEY_FILE));
    const carolChain = chainKeyFrom(await carolStore.getItem(SENDER_KEY_FILE));
    expect(bobChain).toBe(carolChain);
    expect(bobChain.length).toBeGreaterThan(16);

    const stored = await aliceStore.getItem(SENDER_KEY_FILE);
    expect(stored).toBeTruthy();
    const signatureKey = (JSON.parse(stored!) as { records: Array<{ states: Array<{ signatureKey: string }> }> })
      .records[0]?.states[0]?.signatureKey;
    expect(signatureKey && signatureKey.length).toBeGreaterThan(16);

    for (const envelope of prepared.envelopes) {
      const wire = JSON.stringify(envelope);
      expect(fieldNames(envelope).some((name) => /private/i.test(name))).toBe(false);
      expect(wire).not.toContain(bobChain);
      expect(wire).not.toContain(signatureKey);
      expect(wire).not.toContain("hello group");
    }

    const firstPlain = "hello group — first round trip";
    const first = await encryptGroupPlaintext({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      plaintext: firstPlain,
    });
    const decoded = decodeGroupSender(first.ciphertext);
    expect(decoded.senderUserId).toBe(alice.userId);
    expect(decoded.frame.length).toBeGreaterThan(8);
    expect(fieldNames(decoded).some((name) => /private/i.test(name))).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain(firstPlain);
    expect(JSON.stringify(decoded)).not.toContain(bobChain);
    expect(JSON.stringify(decoded)).not.toContain(signatureKey);
    expect(first.ciphertext).not.toContain(firstPlain);

    expect(
      await decryptGroupPlaintext({ store: bobStore, localUserId: bob.userId, ciphertext: first.ciphertext }),
    ).toBe(firstPlain);
    expect(
      await decryptGroupPlaintext({ store: carolStore, localUserId: carol.userId, ciphertext: first.ciphertext }),
    ).toBe(firstPlain);

    const secondPlain = "hello group — second round trip";
    const second = await encryptGroupPlaintext({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      plaintext: secondPlain,
    });
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(
      await decryptGroupPlaintext({ store: bobStore, localUserId: bob.userId, ciphertext: second.ciphertext }),
    ).toBe(secondPlain);
    expect(
      await decryptGroupPlaintext({ store: carolStore, localUserId: carol.userId, ciphertext: second.ciphertext }),
    ).toBe(secondPlain);

    const rotated = await prepareGroupDistributions({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      memberUserIds: [alice.userId, bob.userId],
    });
    expect(rotated.senderKeyId).not.toBe(prepared.senderKeyId);
    expect(rotated.envelopes).toHaveLength(1);
    expect(rotated.envelopes[0]?.recipientUserId).toBe(bob.userId);
    await acceptGroupDistribution({
      store: bobStore,
      localUserId: bob.userId,
      groupId: GROUP,
      protocolDeviceId: LOCAL_PROTOCOL_DEVICE_ID,
      envelope: rotated.envelopes[0]!,
    });

    const afterPlain = "hello group — after membership rotation";
    const after = await encryptGroupPlaintext({
      store: aliceStore,
      localUserId: alice.userId,
      groupId: GROUP,
      plaintext: afterPlain,
    });
    expect(
      await decryptGroupPlaintext({ store: bobStore, localUserId: bob.userId, ciphertext: after.ciphertext }),
    ).toBe(afterPlain);
    await expect(
      decryptGroupPlaintext({ store: carolStore, localUserId: carol.userId, ciphertext: after.ciphertext }),
    ).rejects.toBeInstanceOf(GroupMessageError);
    expect(JSON.stringify(decodeGroupSender(after.ciphertext))).not.toContain(afterPlain);
    expect(() => decodeGroupDistribution(first.ciphertext)).toThrow(GroupMessageError);
  });

  it("posts a group create with member ids and a title, never a private field", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createMessagingClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        const raw = init?.body ? String(init.body) : "";
        calls.push({ url: String(url), body: raw ? (JSON.parse(raw) as unknown) : null });
        return Response.json(
          {
            id: GROUP,
            createdAt: 10,
            kind: "group",
            title: "Design Crit",
            members: [
              { userId: "11111111-1111-4111-8111-111111111111", joinedAt: 10 },
              { userId: "22222222-2222-4222-8222-222222222222", joinedAt: 10 },
              { userId: "33333333-3333-4333-8333-333333333333", joinedAt: 10 },
            ],
          },
          { status: 201 },
        );
      },
    });
    const conversation = await client.createGroup("token", {
      title: "Design Crit",
      memberUserIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
    });
    expect(conversation.kind).toBe("group");
    expect(conversation.title).toBe("Design Crit");
    expect(calls[0]?.body).toEqual({
      title: "Design Crit",
      memberUserIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
    });
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/private/i);
    expect(conversation).not.toHaveProperty("plaintext");
  });
});
