import { HttpError, isRecord, rejectPrivateFields } from "./http";

/** Visible notification copy. This is not a message preview. */
export const PUSH_TITLE = "New message";

export const PUSH_CHANNEL_ID = "messages";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expo push tokens from `getExpoPushTokenAsync`. */
export const EXPO_PUSH_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,256}\]$/;

const CONTENT_FIELD = /^(plaintext|plain_text|text|body|message|content|ciphertext|preview|subject)$/i;

const TOP_KEYS = new Set(["to", "title", "body", "data", "sound", "priority", "channelId"]);
const DATA_KEYS = new Set(["conversationId", "unread"]);
const BATCH_LIMIT = 100;

export type PushPlatform = "ios" | "android";

export type PushRegistration = {
  expoPushToken: string;
  platform: PushPlatform;
  deviceId: string | null;
};

/** Metadata delivered to the app. No message body and no ciphertext. */
export type PushData = {
  conversationId: string;
  unread: true;
};

export type ExpoPushMessage = {
  to: string;
  title: typeof PUSH_TITLE;
  body: typeof PUSH_TITLE;
  data: PushData;
  sound: "default";
  priority: "high";
  channelId: typeof PUSH_CHANNEL_ID;
};

export type PushDelivery = {
  mode: "stub" | "sent";
  attempted: number;
  accepted: number;
  droppedTokens: string[];
};

function rejectContentFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectContentFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CONTENT_FIELD.test(key)) throw new HttpError(400, "plaintext is not accepted");
    rejectContentFields(child);
  }
}

function checkedRecord(body: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  rejectContentFields(body);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(400, "unexpected field");
  }
  return body;
}

export function parsePushRegistration(body: unknown): PushRegistration {
  const record = checkedRecord(body, new Set(["expoPushToken", "platform", "deviceId"]));
  const expoPushToken = record.expoPushToken;
  if (typeof expoPushToken !== "string" || !EXPO_PUSH_TOKEN_RE.test(expoPushToken)) {
    throw new HttpError(400, "invalid expoPushToken");
  }
  const platform = record.platform;
  if (platform !== "ios" && platform !== "android") throw new HttpError(400, "invalid platform");
  let deviceId: string | null = null;
  if (record.deviceId != null) {
    if (typeof record.deviceId !== "string" || !UUID.test(record.deviceId)) {
      throw new HttpError(400, "invalid deviceId");
    }
    deviceId = record.deviceId;
  }
  return { expoPushToken, platform, deviceId };
}

export function parsePushUnregister(body: unknown): string {
  const record = checkedRecord(body, new Set(["expoPushToken"]));
  const expoPushToken = record.expoPushToken;
  if (typeof expoPushToken !== "string" || !EXPO_PUSH_TOKEN_RE.test(expoPushToken)) {
    throw new HttpError(400, "invalid expoPushToken");
  }
  return expoPushToken;
}

/**
 * One Expo push for a new ciphertext row.
 * `title` / `body` are the generic label only. `data` is a conversation id and an unread flag.
 */
export function buildNewMessagePush(to: string, conversationId: string): ExpoPushMessage {
  if (!EXPO_PUSH_TOKEN_RE.test(to)) throw new HttpError(500, "push payload rejected");
  if (!UUID.test(conversationId)) throw new HttpError(500, "push payload rejected");
  const message: ExpoPushMessage = {
    to,
    title: PUSH_TITLE,
    body: PUSH_TITLE,
    data: { conversationId, unread: true },
    sound: "default",
    priority: "high",
    channelId: PUSH_CHANNEL_ID,
  };
  assertMetadataOnly(message);
  return message;
}

export function assertMetadataOnly(message: ExpoPushMessage): void {
  for (const key of Object.keys(message)) {
    if (!TOP_KEYS.has(key)) throw new HttpError(500, "push payload rejected");
  }
  if (message.title !== PUSH_TITLE || message.body !== PUSH_TITLE) {
    throw new HttpError(500, "push payload rejected");
  }
  if (message.sound !== "default" || message.priority !== "high" || message.channelId !== PUSH_CHANNEL_ID) {
    throw new HttpError(500, "push payload rejected");
  }
  if (!EXPO_PUSH_TOKEN_RE.test(message.to)) throw new HttpError(500, "push payload rejected");
  const data = message.data;
  if (!isRecord(data)) throw new HttpError(500, "push payload rejected");
  for (const key of Object.keys(data)) {
    if (!DATA_KEYS.has(key)) throw new HttpError(500, "push payload rejected");
  }
  if (data.unread !== true) throw new HttpError(500, "push payload rejected");
  if (typeof data.conversationId !== "string" || !UUID.test(data.conversationId)) {
    throw new HttpError(500, "push payload rejected");
  }
}

type Ticket = { status: "ok" | "error"; error?: string };

function ticketsOf(payload: unknown): Ticket[] {
  if (!isRecord(payload)) return [];
  const data = payload.data;
  const list = Array.isArray(data) ? data : [];
  return list.map((item) => {
    if (!isRecord(item)) return { status: "error" };
    const details = isRecord(item.details) ? item.details : null;
    const error = details && typeof details.error === "string" ? details.error : undefined;
    return { status: item.status === "ok" ? "ok" : "error", error };
  });
}

async function postBatch(
  fetchImpl: typeof fetch,
  accessToken: string,
  batch: ExpoPushMessage[],
): Promise<Response> {
  const send = () =>
    fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(batch),
    });
  const first = await send();
  if (first.status !== 429 && first.status < 500) return first;
  await new Promise((resolve) => setTimeout(resolve, 250));
  return send();
}

/**
 * Sends metadata-only pushes. With no access token, logs a stub and does not call Expo.
 * `DeviceNotRegistered` tickets are returned so the caller can drop those tokens.
 */
export async function deliverExpoPushes(input: {
  accessToken: string | undefined;
  messages: ExpoPushMessage[];
  fetchImpl?: typeof fetch;
}): Promise<PushDelivery> {
  for (const message of input.messages) assertMetadataOnly(message);
  if (input.messages.length === 0) {
    return { mode: "stub", attempted: 0, accepted: 0, droppedTokens: [] };
  }
  const accessToken = input.accessToken?.trim();
  if (!accessToken) {
    console.log(`push stub count=${input.messages.length} reason=missing EXPO_ACCESS_TOKEN`);
    return { mode: "stub", attempted: input.messages.length, accepted: 0, droppedTokens: [] };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const droppedTokens: string[] = [];
  let accepted = 0;
  for (let offset = 0; offset < input.messages.length; offset += BATCH_LIMIT) {
    const batch = input.messages.slice(offset, offset + BATCH_LIMIT);
    let response: Response;
    try {
      response = await postBatch(fetchImpl, accessToken, batch);
    } catch {
      console.log("push send failed status=network");
      continue;
    }
    if (!response.ok) {
      console.log(`push send failed status=${response.status}`);
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      console.log("push send failed status=200 invalid json");
      continue;
    }
    const tickets = ticketsOf(payload);
    tickets.forEach((ticket, index) => {
      const message = batch[index];
      if (!message) return;
      if (ticket.status === "ok") {
        accepted += 1;
        return;
      }
      if (ticket.error === "DeviceNotRegistered") droppedTokens.push(message.to);
      console.log(`push ticket error=${ticket.error ?? "unknown"}`);
    });
  }
  return { mode: "sent", attempted: input.messages.length, accepted, droppedTokens };
}
