import { assertSecureStoreKey, type KeyValueStore } from "@/e2ee/store";

/** Thread timer. Durations are client-enforced and copied onto `expireAt` at send. */
export const DISAPPEAR_CHOICES = [
  { label: "Off", ms: null },
  { label: "30 seconds", ms: 30_000 },
  { label: "5 minutes", ms: 5 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "1 day", ms: 24 * 60 * 60_000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60_000 },
] as const;

export const DISAPPEAR_LABELS = DISAPPEAR_CHOICES.map((choice) => choice.label);

export type DisappearLabel = (typeof DISAPPEAR_CHOICES)[number]["label"];

const TIMER_PREFS_KEY = "encrypt.disappear.timers";

type TimerFile = { version: 1; choices: Record<string, string> };

export function isDisappearLabel(value: string): value is DisappearLabel {
  return DISAPPEAR_CHOICES.some((choice) => choice.label === value);
}

/** Milliseconds until deletion, or null when disappearing messages are off. */
export function durationMs(label: string): number | null {
  const choice = DISAPPEAR_CHOICES.find((item) => item.label === label);
  return choice ? choice.ms : null;
}

/**
 * Unix millisecond `expireAt` for `POST /conversations/:id/messages`.
 * Undefined when the selection is Off or unknown, so the field is omitted.
 */
export function expireAtForChoice(label: string, now = Date.now()): number | undefined {
  const ms = durationMs(label);
  if (ms == null) return undefined;
  return now + ms;
}

export function isExpired(expireAt: number | null | undefined, now = Date.now()): boolean {
  return typeof expireAt === "number" && expireAt <= now;
}

/** Delay before a local purge. Null when the message does not expire. */
export function purgeDelay(expireAt: number | null | undefined, now = Date.now()): number | null {
  if (typeof expireAt !== "number") return null;
  return Math.max(0, expireAt - now);
}

export function systemLineForTimer(label: string): string {
  if (!isDisappearLabel(label) || label === "Off") return "— Disappearing messages off —";
  return `— Disappearing messages: ${label} —`;
}

function parseTimerFile(raw: string | null): TimerFile {
  if (!raw) return { version: 1, choices: {} };
  try {
    const parsed = JSON.parse(raw) as TimerFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.choices !== "object" || parsed.choices === null) {
      return { version: 1, choices: {} };
    }
    return { version: 1, choices: { ...parsed.choices } };
  } catch {
    return { version: 1, choices: {} };
  }
}

/** Per-chat timer choice. `chatId` is a route id or a peer user id, stored inside one Secure Store value. */
export function createTimerPrefs(store: KeyValueStore) {
  return {
    async load(chatId: string): Promise<DisappearLabel | null> {
      assertSecureStoreKey(chatId);
      const file = parseTimerFile(await store.getItem(TIMER_PREFS_KEY));
      const label = file.choices[chatId];
      return typeof label === "string" && isDisappearLabel(label) ? label : null;
    },
    async save(chatId: string, label: string): Promise<void> {
      assertSecureStoreKey(chatId);
      if (!isDisappearLabel(label)) return;
      const file = parseTimerFile(await store.getItem(TIMER_PREFS_KEY));
      file.choices[chatId] = label;
      await store.setItem(TIMER_PREFS_KEY, JSON.stringify(file));
    },
  };
}

async function securePrefs(): Promise<ReturnType<typeof createTimerPrefs> | null> {
  const SecureStore = await import("expo-secure-store");
  let available = false;
  try {
    available = await SecureStore.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return null;
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return createTimerPrefs({
    getItem(key) {
      return SecureStore.getItemAsync(key, options);
    },
    async setItem(key, value) {
      await SecureStore.setItemAsync(key, value, options);
    },
    async deleteItem(key) {
      await SecureStore.deleteItemAsync(key, options);
    },
  });
}

export async function loadTimerChoice(chatId: string): Promise<DisappearLabel | null> {
  const prefs = await securePrefs();
  if (!prefs) return null;
  return prefs.load(chatId);
}

export async function saveTimerChoice(chatId: string, label: string): Promise<void> {
  const prefs = await securePrefs();
  if (!prefs) return;
  await prefs.save(chatId, label);
}
