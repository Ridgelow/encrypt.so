export { decodeOpaqueEnvelope, encodeOpaqueEnvelope } from "@/e2ee/envelope";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RealtimeTransport = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

/** React Native accepts `{ headers }` as the third WebSocket argument. */
export type RealtimeTransportFactory = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => RealtimeTransport;

export type MessageClientFrame = {
  type: "message";
  conversationId: string;
  ciphertext: string;
  contentType?: string;
  clientId?: string;
  senderDeviceId?: string;
  expireAt?: number;
};

export type ServerFrame =
  | { type: "ready"; userId: string }
  | { type: "subscribed"; conversationId: string }
  | { type: "ack"; conversationId: string; clientId: string | null; id?: string | null }
  | {
      type: "message";
      conversationId: string;
      ciphertext: string;
      contentType: string;
      clientId: string | null;
      senderDeviceId: string | null;
      expireAt: number | null;
      fromUserId: string;
      id: string | null;
      createdAt: number;
    }
  | { type: "error"; error: string; clientId?: string | null };

export type RealtimeConnection = {
  /** Resolves when the server accepts the conversation subscription. */
  subscribed: Promise<void>;
  sendEnvelope(frame: Omit<MessageClientFrame, "type">): Promise<void>;
  close(): void;
};

function defaultFactory(): RealtimeTransportFactory {
  return globalThis.WebSocket as unknown as RealtimeTransportFactory;
}

/** `http(s)` API origin → `ws(s)://…/realtime?conversationId=`. */
export function realtimeWebSocketUrl(httpBase: string, conversationId: string): string {
  const url = new URL(httpBase);
  if (url.protocol === "https:") url.protocol = "wss:";
  else url.protocol = "ws:";
  url.pathname = "/realtime";
  url.search = "";
  url.hash = "";
  url.searchParams.set("conversationId", conversationId);
  return url.toString();
}

export function isDeviceUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

function parseServerFrame(data: unknown): ServerFrame | null {
  const text = typeof data === "string" ? data : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as ServerFrame;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Open one authenticated socket for one conversation.
 * The bearer token is the Auth session. Frames are JSON and never carry plaintext.
 */
export function connectRealtime(options: {
  httpBase: string;
  token: string;
  conversationId: string;
  factory?: RealtimeTransportFactory;
  onFrame: (frame: ServerFrame) => void;
  onClose?: () => void;
}): RealtimeConnection {
  const Factory = options.factory ?? defaultFactory();
  const socket = new Factory(realtimeWebSocketUrl(options.httpBase, options.conversationId), undefined, {
    headers: { Authorization: `Bearer ${options.token}` },
  });

  let subscribed = false;
  let failed: Error | null = null;
  const waiters: Array<() => void> = [];
  const pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

  const subscribedPromise = new Promise<void>((resolve, reject) => {
    waiters.push(() => {
      if (failed) reject(failed);
      else resolve();
    });
  });
  subscribedPromise.catch(() => undefined);

  function finishSubscribe(): void {
    subscribed = true;
    for (const waiter of waiters.splice(0)) waiter();
  }

  function fail(error: string): void {
    if (failed) return;
    failed = new Error(error);
    if (!subscribed) {
      for (const waiter of waiters.splice(0)) waiter();
    }
    for (const entry of pending.values()) entry.reject(failed);
    pending.clear();
  }

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "subscribe", conversationId: options.conversationId }));
  };
  socket.onmessage = (event) => {
    const frame = parseServerFrame(event.data);
    if (!frame) return;
    if (frame.type === "subscribed" && frame.conversationId === options.conversationId) finishSubscribe();
    if (frame.type === "ack" && frame.clientId) pending.get(frame.clientId)?.resolve();
    if (frame.type === "ack" && frame.clientId) pending.delete(frame.clientId);
    if (frame.type === "error") {
      const clientId = frame.clientId;
      if (clientId && pending.has(clientId)) {
        pending.get(clientId)?.reject(new Error(frame.error));
        pending.delete(clientId);
      } else if (!subscribed) {
        fail(frame.error);
      }
    }
    options.onFrame(frame);
  };
  socket.onerror = () => {
    if (!subscribed) fail("realtime connection failed");
  };
  socket.onclose = () => {
    if (!subscribed) fail("realtime connection closed");
    options.onClose?.();
  };

  let closed = false;
  return {
    subscribed: subscribedPromise,
    sendEnvelope(frame) {
      const body: MessageClientFrame = {
        type: "message",
        conversationId: frame.conversationId,
        ciphertext: frame.ciphertext,
      };
      if (frame.contentType) body.contentType = frame.contentType;
      if (frame.clientId) body.clientId = frame.clientId;
      if (frame.senderDeviceId) body.senderDeviceId = frame.senderDeviceId;
      if (frame.expireAt != null) body.expireAt = frame.expireAt;
      const encoded = JSON.stringify(body);
      return subscribedPromise.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (failed) {
              reject(failed);
              return;
            }
            if (frame.clientId) pending.set(frame.clientId, { resolve, reject });
            try {
              socket.send(encoded);
            } catch (err) {
              if (frame.clientId) pending.delete(frame.clientId);
              reject(err instanceof Error ? err : new Error("realtime send failed"));
              return;
            }
            if (!frame.clientId) resolve();
          }),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}
