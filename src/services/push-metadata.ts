const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PushPlatform = "ios" | "android";

export type PushRegisterInput = {
  expoPushToken: string;
  platform: PushPlatform;
  deviceId?: string;
};

/** Body for POST /push/register. Device id is omitted until the worker has a device row. */
export function registrationBody(input: {
  expoPushToken: string;
  platform: PushPlatform;
  deviceId: string | null;
}): PushRegisterInput {
  return {
    expoPushToken: input.expoPushToken,
    platform: input.platform,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
  };
}

const LAUNCH_WINDOW_MS = 15_000;

/**
 * Conversation id from a push `data` object, when it matches the metadata contract.
 * Other fields are ignored and never returned.
 */
export function inboxConversationId(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const id = record.conversationId;
  const unread = record.unread;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (unread !== true && unread !== "true") return null;
  return id;
}

/**
 * Cold start should open the chat list only when this process was launched from
 * a recent metadata push. Older responses are ignored so a later launch stays put.
 */
export function shouldOpenInboxFromLaunch(input: {
  data: unknown;
  notificationDate: number;
  now?: number;
}): boolean {
  if (!inboxConversationId(input.data)) return false;
  if (!Number.isFinite(input.notificationDate)) return false;
  const now = input.now ?? Date.now();
  const dateMs =
    input.notificationDate < 10_000_000_000 ? input.notificationDate * 1000 : input.notificationDate;
  const age = now - dateMs;
  return age >= 0 && age <= LAUNCH_WINDOW_MS;
}

/** `serverDeviceId` from the on-device key record, without returning the rest of the record. */
export function serverDeviceIdFromRecord(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const id = (parsed as { serverDeviceId?: unknown }).serverDeviceId;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}
