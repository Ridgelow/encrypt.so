import * as SecureStore from "expo-secure-store";
import type { KeyValueStore } from "./store";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Private key material. Session tokens use `src/services/session.ts`. */
export function createExpoKeyValueStore(): KeyValueStore {
  return {
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
}

export async function isDeviceKeyStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}
