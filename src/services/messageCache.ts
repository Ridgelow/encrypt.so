import { createChunkedStore, type KeyValueStore } from "@/e2ee/store";

/**
 * On-device cache of recently decrypted messages.
 * Plaintext stays in Secure Store and is never sent to the worker.
 * iOS Secure Store values are chunked the same way as device keys.
 */
export const MESSAGE_CACHE_KEY = "encrypt.messageCache";
export const MESSAGE_CACHE_LIMIT = 40;
const MAX_PLAINTEXT_CHARS = 8_000;

export type CachedMessage = {
  id: string;
  conversationId: string;
  /** Decrypted on this device. */
  plaintext: string;
  createdAt: number;
  contentType?: string;
  senderDeviceId?: string;
  /** Unix milliseconds. Absent when the message does not disappear. */
  expireAt?: number;
  /** Local display direction. Never sent to the worker. */
  from?: "me" | "them";
};

export type MessageCache = {
  /** Insert or replace by id. Keeps the newest {@link MESSAGE_CACHE_LIMIT} messages. */
  save(message: CachedMessage): Promise<void>;
  /** Oldest first. Omit `conversationId` to read every cached conversation. */
  list(conversationId?: string): Promise<CachedMessage[]>;
  remove(id: string): Promise<void>;
  /** Drop messages whose `expireAt` is at or before `now`. Returns the removed ids. */
  purgeExpired(now?: number): Promise<string[]>;
  clear(): Promise<void>;
};

type CacheFile = { messages: CachedMessage[] };

function isCachedMessage(value: unknown): value is CachedMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as CachedMessage;
  const fromOk = message.from === undefined || message.from === "me" || message.from === "them";
  return (
    typeof message.id === "string" &&
    typeof message.conversationId === "string" &&
    typeof message.plaintext === "string" &&
    typeof message.createdAt === "number" &&
    (message.expireAt === undefined || typeof message.expireAt === "number") &&
    fromOk
  );
}

function assertMessage(message: CachedMessage): void {
  if (!message.id || !message.conversationId) {
    throw new Error("Cached message is missing an id.");
  }
  if (typeof message.plaintext !== "string") {
    throw new Error("Cached message is missing plaintext.");
  }
  if (message.plaintext.length > MAX_PLAINTEXT_CHARS) {
    throw new Error("Decrypted message is too large for the local cache.");
  }
}

async function readAll(store: KeyValueStore): Promise<CachedMessage[]> {
  const raw = await store.getItem(MESSAGE_CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || !Array.isArray(parsed.messages)) return [];
    return parsed.messages.filter(isCachedMessage);
  } catch {
    return [];
  }
}

function byTime(a: CachedMessage, b: CachedMessage): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** `store` is usually a chunked Secure Store. Tests can pass a memory store. */
export function createMessageCache(store: KeyValueStore, limit = MESSAGE_CACHE_LIMIT): MessageCache {
  return {
    async save(message) {
      assertMessage(message);
      const stored: CachedMessage = {
        id: message.id,
        conversationId: message.conversationId,
        plaintext: message.plaintext,
        createdAt: message.createdAt,
        ...(message.contentType ? { contentType: message.contentType } : {}),
        ...(message.senderDeviceId ? { senderDeviceId: message.senderDeviceId } : {}),
        ...(typeof message.expireAt === "number" ? { expireAt: message.expireAt } : {}),
        ...(message.from === "me" || message.from === "them" ? { from: message.from } : {}),
      };
      const existing = (await readAll(store)).filter((item) => item.id !== message.id);
      const next = [...existing, stored].sort(byTime);
      const trimmed = next.slice(Math.max(0, next.length - limit));
      await store.setItem(MESSAGE_CACHE_KEY, JSON.stringify({ messages: trimmed }));
    },
    async list(conversationId) {
      const all = await readAll(store);
      const filtered = conversationId ? all.filter((item) => item.conversationId === conversationId) : all;
      return filtered.sort(byTime);
    },
    async remove(id) {
      const next = (await readAll(store)).filter((item) => item.id !== id);
      if (next.length === 0) {
        await store.deleteItem(MESSAGE_CACHE_KEY);
        return;
      }
      await store.setItem(MESSAGE_CACHE_KEY, JSON.stringify({ messages: next }));
    },
    async purgeExpired(now = Date.now()) {
      const all = await readAll(store);
      const expired = all.filter((item) => typeof item.expireAt === "number" && item.expireAt <= now);
      if (expired.length === 0) return [];
      const drop = new Set(expired.map((item) => item.id));
      const next = all.filter((item) => !drop.has(item.id));
      if (next.length === 0) {
        await store.deleteItem(MESSAGE_CACHE_KEY);
      } else {
        await store.setItem(MESSAGE_CACHE_KEY, JSON.stringify({ messages: next }));
      }
      return expired.map((item) => item.id);
    },
    async clear() {
      await store.deleteItem(MESSAGE_CACHE_KEY);
    },
  };
}

/**
 * Secure Store cache of recent plaintext. Returns null when Secure Store
 * is unavailable (web, or a locked keychain) so callers can skip the cache.
 */
export async function openSecureMessageCache(): Promise<MessageCache | null> {
  const SecureStore = await import("expo-secure-store");
  let available = false;
  try {
    available = await SecureStore.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return null;

  const options = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  const raw: KeyValueStore = {
    getItem(key) {
      return SecureStore.getItemAsync(key, options);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value, options);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key, options);
    },
  };
  return createMessageCache(createChunkedStore(raw));
}
