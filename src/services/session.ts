import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "encrypt.session";
const USER_KEY = "encrypt.userId";

async function storeAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function saveSession(sessionToken: string, userId: string): Promise<void> {
  if (!(await storeAvailable())) return;
  await SecureStore.setItemAsync(TOKEN_KEY, sessionToken);
  await SecureStore.setItemAsync(USER_KEY, userId);
}

export async function loadSession(): Promise<{ sessionToken: string; userId: string } | null> {
  if (!(await storeAvailable())) return null;
  const sessionToken = await SecureStore.getItemAsync(TOKEN_KEY);
  const userId = await SecureStore.getItemAsync(USER_KEY);
  if (!sessionToken || !userId) return null;
  return { sessionToken, userId };
}

export async function clearSession(): Promise<void> {
  if (!(await storeAvailable())) return;
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}
