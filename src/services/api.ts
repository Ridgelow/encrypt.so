import { ApiError } from "@/services/errors";

/**
 * Client for the encrypt.so Worker.
 * Set EXPO_PUBLIC_API_URL (no trailing slash). When it is unset, callers
 * should keep the offline phone flow.
 */

export type SignedPrekey = {
  keyId: number;
  publicKey: string;
  signature: string;
};

export type OneTimePrekey = {
  keyId: number;
  publicKey: string;
};

export type PrekeyBundleUpload = {
  identityKey: string;
  signedPrekey: SignedPrekey;
  oneTimePrekeys: OneTimePrekey[];
};

export type PublicPrekeyBundle = {
  deviceId: string;
  identityKey: string;
  signedPrekey: SignedPrekey;
  oneTimePrekey: OneTimePrekey | null;
};

export type SessionResponse = {
  sessionToken: string;
  userId: string;
};

export type MeResponse = {
  user: { id: string; phone: string; createdAt: number };
  devices: Array<{
    id: string;
    name: string;
    createdAt: number;
    identityKey: string | null;
    bundleUpdatedAt: number | null;
  }>;
};

export type DeviceResponse = {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
};

export type PutPrekeyBundleResponse = {
  deviceId: string;
  bundleUpdatedAt: number;
  oneTimePrekeyCount: number;
};

export type GetPrekeyBundleResponse = {
  userId: string;
  bundles: PublicPrekeyBundle[];
};

export type ConversationMember = {
  userId: string;
  joinedAt: number;
};

export type Conversation = {
  id: string;
  createdAt: number;
  members: ConversationMember[];
};

/** Opaque ciphertext row. The worker does not have a plaintext field. */
export type CiphertextMessage = {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  ciphertext: string;
  contentType: string;
  createdAt: number;
  expireAt: number | null;
  clientId: string | null;
};

export type PostMessageInput = {
  ciphertext: string;
  contentType?: string;
  clientId?: string;
  /** Required when the session has more than one device. */
  senderDeviceId?: string;
  expireAt?: number;
};

export type MessagePage = {
  messages: CiphertextMessage[];
  nextCursor: string | null;
};

export type ConversationList = {
  conversations: Conversation[];
};

/** Ciphertext persistence. Auth routes stay on {@link AuthClient}. */
export interface MessagingClient {
  /** POST /conversations { peerUserId } → conversation */
  createConversation(token: string, peerUserId: string): Promise<Conversation>;
  /** GET /conversations */
  listConversations(token: string): Promise<ConversationList>;
  /** POST /conversations/:id/messages — ciphertext only */
  postMessage(token: string, conversationId: string, body: PostMessageInput): Promise<CiphertextMessage>;
  /** GET /conversations/:id/messages?cursor=&limit= */
  listMessages(
    token: string,
    conversationId: string,
    query?: { cursor?: string; limit?: number },
  ): Promise<MessagePage>;
}

/** Locked Auth worker surface. Live and mock clients both implement this. */
export interface AuthClient {
  /** POST /auth/phone/start { phone } → { challengeId } */
  startPhoneAuth(phone: string): Promise<{ challengeId: string }>;
  /** POST /auth/phone/verify { challengeId, code } → { sessionToken, userId } */
  verifyPhoneAuth(challengeId: string, code: string): Promise<SessionResponse>;
  /** GET /me  Authorization: Bearer sessionToken → { user, devices } */
  getMe(token: string): Promise<MeResponse>;
  /** POST /devices { name } → device */
  createDevice(token: string, name: string): Promise<DeviceResponse>;
  /** PUT /devices/:id/prekey-bundle — public material only */
  putPrekeyBundle(token: string, deviceId: string, bundle: PrekeyBundleUpload): Promise<PutPrekeyBundleResponse>;
  /** GET /users/:userId/prekey-bundle → public bundles (one consumed OTPK each) */
  getPrekeyBundle(token: string, userId: string): Promise<GetPrekeyBundleResponse>;
}

export type AuthClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const PLAINTEXT_FIELD = /^(plaintext|plain_text|text|body|message|content)$/i;

function rejectPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPrivateFields(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/private/i.test(key)) {
      throw new ApiError("private keys are not accepted", 400);
    }
    rejectPrivateFields(child);
  }
}

function rejectPlaintextFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPlaintextFields(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (PLAINTEXT_FIELD.test(key)) {
      throw new ApiError("plaintext is not accepted", 400);
    }
    rejectPlaintextFields(child);
  }
}

function baseUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export function isApiConfigured(): boolean {
  return baseUrl() !== null;
}

/** +1 field plus the digits collected on the phone screen. */
export function toE164(local: string): string {
  const digits = local.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

type RequestInit = {
  method?: string;
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (init.baseUrl ?? baseUrl())?.replace(/\/$/, "") ?? null;
  if (!base) throw new ApiError("API URL is not configured", 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  const fetchImpl = init.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.token) headers.Authorization = `Bearer ${init.token}`;

    const res = await fetchImpl(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new ApiError("unexpected response", res.status);
      }
    }

    if (!res.ok) {
      const message =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : `request failed (${res.status})`;
      throw new ApiError(message, res.status);
    }

    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err instanceof Error ? err.message : "network error", 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Live client. `baseUrl` is the worker origin with no path. */
export function createAuthClient(options: AuthClientOptions): AuthClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const transport = { baseUrl, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };
  return {
    startPhoneAuth(phone) {
      return request("/auth/phone/start", { ...transport, method: "POST", body: { phone } });
    },
    verifyPhoneAuth(challengeId, code) {
      return request("/auth/phone/verify", {
        ...transport,
        method: "POST",
        body: { challengeId, code },
      });
    },
    getMe(token) {
      return request("/me", { ...transport, token });
    },
    createDevice(token, name) {
      return request("/devices", { ...transport, method: "POST", token, body: { name } });
    },
    async putPrekeyBundle(token, deviceId, bundle) {
      rejectPrivateFields(bundle);
      return request(`/devices/${encodeURIComponent(deviceId)}/prekey-bundle`, {
        ...transport,
        method: "PUT",
        token,
        body: bundle,
      });
    },
    getPrekeyBundle(token, userId) {
      return request(`/users/${encodeURIComponent(userId)}/prekey-bundle`, { ...transport, token });
    },
  };
}

function live(): AuthClient {
  const base = baseUrl();
  if (!base) throw new ApiError("API URL is not configured", 0);
  return createAuthClient({ baseUrl: base });
}

/** POST /auth/phone/start */
export function startPhoneAuth(phone: string): Promise<{ challengeId: string }> {
  return live().startPhoneAuth(phone);
}

/** POST /auth/phone/verify */
export function verifyPhoneAuth(challengeId: string, code: string): Promise<SessionResponse> {
  return live().verifyPhoneAuth(challengeId, code);
}

/** GET /me */
export function getMe(token: string): Promise<MeResponse> {
  return live().getMe(token);
}

/** POST /devices */
export function createDevice(token: string, name: string): Promise<DeviceResponse> {
  return live().createDevice(token, name);
}

/** PUT /devices/:id/prekey-bundle — public material only */
export function putPrekeyBundle(
  token: string,
  deviceId: string,
  bundle: PrekeyBundleUpload,
): Promise<PutPrekeyBundleResponse> {
  return live().putPrekeyBundle(token, deviceId, bundle);
}

/** GET /users/:userId/prekey-bundle — consumes one one-time prekey per device */
export function getPrekeyBundle(token: string, userId: string): Promise<GetPrekeyBundleResponse> {
  return live().getPrekeyBundle(token, userId);
}

/** Live ciphertext client. `baseUrl` is the worker origin with no path. */
export function createMessagingClient(options: AuthClientOptions): MessagingClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const transport = { baseUrl, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };
  return {
    createConversation(token, peerUserId) {
      return request("/conversations", {
        ...transport,
        method: "POST",
        token,
        body: { peerUserId },
      });
    },
    listConversations(token) {
      return request("/conversations", { ...transport, token });
    },
    async postMessage(token, conversationId, body) {
      rejectPrivateFields(body);
      rejectPlaintextFields(body);
      return request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
        ...transport,
        method: "POST",
        token,
        body,
      });
    },
    listMessages(token, conversationId, query) {
      const params = new URLSearchParams();
      if (query?.cursor) params.set("cursor", query.cursor);
      if (query?.limit != null) params.set("limit", String(query.limit));
      const qs = params.toString();
      return request(
        `/conversations/${encodeURIComponent(conversationId)}/messages${qs ? `?${qs}` : ""}`,
        { ...transport, token },
      );
    },
  };
}

function liveMessages(): MessagingClient {
  const base = baseUrl();
  if (!base) throw new ApiError("API URL is not configured", 0);
  return createMessagingClient({ baseUrl: base });
}

/** POST /conversations */
export function createConversation(token: string, peerUserId: string): Promise<Conversation> {
  return liveMessages().createConversation(token, peerUserId);
}

/** GET /conversations */
export function listConversations(token: string): Promise<ConversationList> {
  return liveMessages().listConversations(token);
}

/** POST /conversations/:id/messages — ciphertext only */
export function postMessage(
  token: string,
  conversationId: string,
  body: PostMessageInput,
): Promise<CiphertextMessage> {
  return liveMessages().postMessage(token, conversationId, body);
}

/** GET /conversations/:id/messages */
export function listMessages(
  token: string,
  conversationId: string,
  query?: { cursor?: string; limit?: number },
): Promise<MessagePage> {
  return liveMessages().listMessages(token, conversationId, query);
}
