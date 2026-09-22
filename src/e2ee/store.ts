/**
 * iOS has historically rejected SecureStore values above roughly 2048 bytes.
 * Expo does not enforce a limit. Chunk below that so an ML-KEM private key
 * still fits in the keychain / keystore.
 */
export const SECURE_STORE_VALUE_CHUNK = 1800;

const KEY_PATTERN = /^[\w.-]+$/;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export function assertSecureStoreKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("Secure store key is not valid.");
  }
}

export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      assertSecureStoreKey(key);
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      assertSecureStoreKey(key);
      map.set(key, value);
    },
    async deleteItem(key) {
      assertSecureStoreKey(key);
      map.delete(key);
    },
  };
}

async function deleteParts(raw: KeyValueStore, key: string, count: number): Promise<void> {
  await raw.deleteItem(`${key}.parts`);
  for (let index = 0; index < count; index += 1) {
    await raw.deleteItem(`${key}.p${index}`);
  }
}

function partCount(raw: string | null): number {
  if (raw == null) return 0;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) return 0;
  return count;
}

/** Splits oversized values so every underlying write stays within the chunk size. */
export function createChunkedStore(raw: KeyValueStore): KeyValueStore {
  return {
    async getItem(key) {
      assertSecureStoreKey(key);
      const count = partCount(await raw.getItem(`${key}.parts`));
      if (count === 0) return raw.getItem(key);
      let value = "";
      for (let index = 0; index < count; index += 1) {
        const piece = await raw.getItem(`${key}.p${index}`);
        if (piece == null) {
          throw new Error("Stored device keys are unreadable.");
        }
        value += piece;
      }
      return value;
    },
    async setItem(key, value) {
      assertSecureStoreKey(key);
      const previous = partCount(await raw.getItem(`${key}.parts`));
      if (value.length <= SECURE_STORE_VALUE_CHUNK) {
        await raw.setItem(key, value);
        if (previous > 0) await deleteParts(raw, key, previous);
        return;
      }
      const count = Math.ceil(value.length / SECURE_STORE_VALUE_CHUNK);
      for (let index = 0; index < count; index += 1) {
        const piece = value.slice(
          index * SECURE_STORE_VALUE_CHUNK,
          (index + 1) * SECURE_STORE_VALUE_CHUNK,
        );
        await raw.setItem(`${key}.p${index}`, piece);
      }
      await raw.setItem(`${key}.parts`, String(count));
      await raw.deleteItem(key);
      for (let index = count; index < previous; index += 1) {
        await raw.deleteItem(`${key}.p${index}`);
      }
    },
    async deleteItem(key) {
      assertSecureStoreKey(key);
      const previous = partCount(await raw.getItem(`${key}.parts`));
      await raw.deleteItem(key);
      if (previous > 0) await deleteParts(raw, key, previous);
    },
  };
}
