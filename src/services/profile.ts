import * as SecureStore from "expo-secure-store";

const NAME_KEY = "encrypt.displayName.v1";

export async function saveDisplayName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    await SecureStore.deleteItemAsync(NAME_KEY);
    return;
  }
  await SecureStore.setItemAsync(NAME_KEY, trimmed.slice(0, 64));
}

export async function loadDisplayName(): Promise<string | null> {
  const value = await SecureStore.getItemAsync(NAME_KEY);
  return value?.trim() || null;
}
