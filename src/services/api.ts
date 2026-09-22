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
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = baseUrl();
  if (!base) throw new ApiError("API URL is not configured", 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.token) headers.Authorization = `Bearer ${init.token}`;

    const res = await fetch(`${base}${path}`, {
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

/** POST /auth/phone/start */
export function startPhoneAuth(phone: string): Promise<{ challengeId: string }> {
  return request("/auth/phone/start", { method: "POST", body: { phone } });
}

/** POST /auth/phone/verify */
export function verifyPhoneAuth(challengeId: string, code: string): Promise<SessionResponse> {
  return request("/auth/phone/verify", { method: "POST", body: { challengeId, code } });
}

/** GET /me */
export function getMe(token: string): Promise<MeResponse> {
  return request("/me", { token });
}

/** POST /devices */
export function createDevice(token: string, name: string): Promise<DeviceResponse> {
  return request("/devices", { method: "POST", token, body: { name } });
}

/** PUT /devices/:id/prekey-bundle — public material only */
export function putPrekeyBundle(
  token: string,
  deviceId: string,
  bundle: PrekeyBundleUpload,
): Promise<{ deviceId: string; bundleUpdatedAt: number; oneTimePrekeyCount: number }> {
  return request(`/devices/${deviceId}/prekey-bundle`, {
    method: "PUT",
    token,
    body: bundle,
  });
}

/** GET /users/:userId/prekey-bundle — consumes one one-time prekey per device */
export function getPrekeyBundle(
  token: string,
  userId: string,
): Promise<{ userId: string; bundles: PublicPrekeyBundle[] }> {
  return request(`/users/${userId}/prekey-bundle`, { token });
}
