import { describe, expect, it } from "vitest";
import { createChunkedStore, type KeyValueStore } from "../src/e2ee/store";
import { createMessageCache, MESSAGE_CACHE_KEY, MESSAGE_CACHE_LIMIT } from "../src/services/messageCache";

function memoryStore(): { store: KeyValueStore; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const backing: KeyValueStore = {
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
  return { store: createChunkedStore(backing), raw };
}

describe("decrypted message cache", () => {
  it("keeps recent plaintext for one conversation and drops the oldest", async () => {
    const { store, raw } = memoryStore();
    const cache = createMessageCache(store, 2);

    await cache.save({ id: "m1", conversationId: "c1", plaintext: "one", createdAt: 1 });
    await cache.save({ id: "m2", conversationId: "c2", plaintext: "two", createdAt: 2 });
    await cache.save({ id: "m3", conversationId: "c1", plaintext: "three", createdAt: 3 });

    expect(await cache.list("c1")).toEqual([
      { id: "m3", conversationId: "c1", plaintext: "three", createdAt: 3 },
    ]);
    expect(await cache.list("c2")).toEqual([
      { id: "m2", conversationId: "c2", plaintext: "two", createdAt: 2 },
    ]);
    expect(await cache.list()).toEqual([
      { id: "m2", conversationId: "c2", plaintext: "two", createdAt: 2 },
      { id: "m3", conversationId: "c1", plaintext: "three", createdAt: 3 },
    ]);

    await cache.save({ id: "m3", conversationId: "c1", plaintext: "three-edited", createdAt: 4 });
    expect(await cache.list("c1")).toEqual([
      { id: "m3", conversationId: "c1", plaintext: "three-edited", createdAt: 4 },
    ]);

    const stored = [...raw.values()].join("");
    expect(stored).toContain("three-edited");
    expect(raw.has(MESSAGE_CACHE_KEY) || raw.has(`${MESSAGE_CACHE_KEY}.parts`)).toBe(true);

    await cache.remove("m3");
    await cache.clear();
    expect(await cache.list()).toEqual([]);
    expect(MESSAGE_CACHE_LIMIT).toBeGreaterThan(1);
  });

  it("refuses an oversized decrypted message", async () => {
    const { store } = memoryStore();
    const cache = createMessageCache(store);
    await expect(
      cache.save({
        id: "big",
        conversationId: "c1",
        plaintext: "x".repeat(8_001),
        createdAt: 1,
      }),
    ).rejects.toThrow(/too large/);
  });
});
