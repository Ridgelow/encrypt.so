import type { OpaqueEnvelope } from "@/e2ee";
import type { CiphertextMessage, MessagingClient, PostMessageInput } from "@/services/api";
import { readOpaqueCiphertext } from "@/services/ciphertext";
import { isExpired } from "@/services/disappear";
import { openSecureMessageCache, type CachedMessage, type MessageCache } from "@/services/messageCache";
import {
  connectRealtime,
  encodeOpaqueEnvelope,
  isDeviceUuid,
  type RealtimeTransportFactory,
  type ServerFrame,
} from "@/services/realtime";

export type LiveThreadMessage = {
  id: string;
  from: "me" | "them";
  text: string;
  createdAt: number;
  envelope?: OpaqueEnvelope;
  /** Unix milliseconds. Null when the message does not disappear. */
  expireAt?: number | null;
};

export type LivePublishOptions = {
  /** Unix milliseconds copied onto the socket frame and the ciphertext post. */
  expireAt?: number | null;
  createdAt?: number;
};

export type LiveChat = {
  conversationId: string;
  /** Oldest first, loaded before the socket is required for sending. */
  history: LiveThreadMessage[];
  publish(envelope: OpaqueEnvelope, plaintext: string, options?: LivePublishOptions): Promise<{ id: string }>;
  close(): void;
};

const HISTORY_PAGE = 50;
const HISTORY_PAGES = 5;

async function loadPages(
  messaging: Pick<MessagingClient, "listMessages">,
  token: string,
  conversationId: string,
): Promise<CiphertextMessage[]> {
  const rows: CiphertextMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const result = await messaging.listMessages(token, conversationId, { cursor, limit: HISTORY_PAGE });
    rows.push(...result.messages);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

/**
 * 1:1 live chat. The conversation id comes from `POST /conversations`.
 * Sends go out on the WebSocket and, best effort, `POST /conversations/:id/messages`.
 * Incoming envelopes are decrypted on device and written to the message cache.
 * Mock chats should not call this.
 */
export async function openLiveChat(options: {
  httpBase: string;
  sessionToken: string;
  localUserId: string;
  peerUserId: string;
  messaging: Pick<MessagingClient, "createConversation" | "postMessage" | "listMessages">;
  decrypt: (envelope: OpaqueEnvelope) => Promise<string>;
  cache?: MessageCache | null;
  factory?: RealtimeTransportFactory;
  onMessage: (message: LiveThreadMessage) => void;
}): Promise<LiveChat> {
  const conversation = await options.messaging.createConversation(options.sessionToken, options.peerUserId);
  const cache =
    options.cache === undefined ? await openSecureMessageCache().catch(() => null) : options.cache;

  let tail: Promise<void> = Promise.resolve();

  async function remember(message: LiveThreadMessage, senderDeviceId?: string): Promise<void> {
    if (!cache) return;
    const entry: CachedMessage = {
      id: message.id,
      conversationId: conversation.id,
      plaintext: message.text,
      createdAt: message.createdAt,
      senderDeviceId,
      from: message.from,
      ...(typeof message.expireAt === "number" ? { expireAt: message.expireAt } : {}),
    };
    try {
      await cache.save(entry);
    } catch {
      // The thread still updates if Secure Store refuses the write.
    }
  }

  async function incoming(frame: Extract<ServerFrame, { type: "message" }>): Promise<void> {
    if (isExpired(frame.expireAt)) return;
    const envelope = readOpaqueCiphertext(frame.ciphertext);
    if (!envelope) return;
    const id = frame.clientId ?? frame.id ?? `live-${frame.createdAt}`;
    if (envelope.senderUserId === options.localUserId) return;
    let text = "Message unavailable";
    try {
      text = await options.decrypt(envelope);
    } catch {
      text = "Message unavailable";
    }
    const message: LiveThreadMessage = {
      id,
      from: "them",
      text,
      createdAt: frame.createdAt || Date.now(),
      envelope,
      expireAt: frame.expireAt,
    };
    options.onMessage(message);
    if (text !== "Message unavailable") await remember(message, frame.senderDeviceId ?? undefined);
  }

  if (cache) {
    try {
      await cache.purgeExpired();
    } catch {
      // History still loads when the cache cannot drop expired rows.
    }
  }
  const cached = cache ? await cache.list(conversation.id).catch(() => []) : [];
  const cachedById = new Map(cached.map((message) => [message.id, message]));
  let rows: CiphertextMessage[] = [];
  try {
    rows = await loadPages(options.messaging, options.sessionToken, conversation.id);
  } catch {
    rows = [];
  }

  const history: LiveThreadMessage[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isExpired(row.expireAt)) continue;
    const envelope = readOpaqueCiphertext(row.ciphertext);
    const id = row.clientId ?? row.id;
    if (seen.has(id)) continue;
    const saved = cachedById.get(id) ?? cachedById.get(row.id);
    const expireAt = row.expireAt ?? saved?.expireAt ?? null;
    if (envelope?.senderUserId === options.localUserId || saved?.from === "me") {
      if (!saved) continue;
      seen.add(id);
      history.push({
        id,
        from: "me",
        text: saved.plaintext,
        createdAt: saved.createdAt,
        envelope: envelope ?? undefined,
        expireAt,
      });
      continue;
    }
    if (!envelope) continue;
    seen.add(id);
    let text = saved?.plaintext;
    if (text == null) {
      try {
        text = await options.decrypt(envelope);
      } catch {
        text = "Message unavailable";
      }
      if (text !== "Message unavailable") {
        await remember(
          { id, from: "them", text, createdAt: row.createdAt, envelope, expireAt },
          row.senderDeviceId,
        );
      }
    }
    history.push({
      id,
      from: "them",
      text,
      createdAt: row.createdAt,
      envelope,
      expireAt,
    });
  }

  for (const saved of cached) {
    if (seen.has(saved.id) || saved.from !== "me" || isExpired(saved.expireAt)) continue;
    seen.add(saved.id);
    history.push({
      id: saved.id,
      from: "me",
      text: saved.plaintext,
      createdAt: saved.createdAt,
      expireAt: saved.expireAt ?? null,
    });
  }
  history.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const connection = connectRealtime({
    httpBase: options.httpBase,
    token: options.sessionToken,
    conversationId: conversation.id,
    factory: options.factory,
    onFrame(frame) {
      if (frame.type !== "message") return;
      const run = tail.then(() => incoming(frame), () => incoming(frame));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
    },
  });

  return {
    conversationId: conversation.id,
    history,
    async publish(envelope, plaintext, publishOptions) {
      const clientId = crypto.randomUUID();
      const ciphertext = encodeOpaqueEnvelope(envelope);
      const senderDeviceId = isDeviceUuid(envelope.senderDeviceId) ? envelope.senderDeviceId : undefined;
      const expireAt = typeof publishOptions?.expireAt === "number" ? publishOptions.expireAt : undefined;
      const body: PostMessageInput = {
        ciphertext,
        contentType: "application/octet-stream",
        clientId,
        senderDeviceId,
      };
      if (expireAt != null) body.expireAt = expireAt;
      const createdAt = publishOptions?.createdAt ?? Date.now();
      try {
        await connection.sendEnvelope({
          conversationId: conversation.id,
          ciphertext,
          contentType: body.contentType,
          clientId,
          senderDeviceId,
          ...(expireAt != null ? { expireAt } : {}),
        });
      } catch (err) {
        console.warn("[realtime] fan-out skipped", err instanceof Error ? err.message : "");
      }
      try {
        await options.messaging.postMessage(options.sessionToken, conversation.id, body);
      } catch (err) {
        console.warn("[realtime] persist skipped", err instanceof Error ? err.message : "");
      }
      await remember(
        { id: clientId, from: "me", text: plaintext, createdAt, expireAt: expireAt ?? null },
        senderDeviceId,
      );
      return { id: clientId };
    },
    close() {
      connection.close();
    },
  };
}

/** True when this thread should open a socket. Mock chats and missing sessions stay offline. */
export function liveChatEnabled(input: {
  peerUserId: string | null;
  isGroup: boolean;
  apiConfigured: boolean;
  hasSession: boolean;
}): boolean {
  return Boolean(input.peerUserId) && !input.isGroup && input.apiConfigured && input.hasSession;
}
