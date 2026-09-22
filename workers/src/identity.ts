import { HttpError, isRecord, rejectPrivateFields } from "./http";

const MAX_OTPK = 100;
const PUBLIC_RE = /^[A-Za-z0-9+/=_-]+$/;

type SignedPrekey = {
  keyId: number;
  publicKey: string;
  signature: string;
};

type OneTimePrekey = {
  keyId: number;
  publicKey: string;
};

type DeviceRow = {
  id: string;
  device_name: string;
  created_at: number;
  identity_key: string | null;
  bundle_updated_at: number | null;
};

type BundleRow = {
  id: string;
  identity_key: string;
  signed_prekey_id: number;
  signed_prekey_public: string;
  signed_prekey_signature: string;
};

function asName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "name required");
  const name = value.trim();
  if (name.length < 1 || name.length > 64) throw new HttpError(400, "invalid name");
  return name;
}

function asPublic(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || !PUBLIC_RE.test(value)) {
    throw new HttpError(400, `invalid ${field}`);
  }
  return value;
}

function asKeyId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new HttpError(400, `invalid ${field}`);
  }
  return value;
}

function parseBundle(body: unknown): {
  identityKey: string;
  signedPrekey: SignedPrekey;
  oneTimePrekeys: OneTimePrekey[];
} {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  const identityKey = asPublic(body.identityKey, "identityKey");
  if (!isRecord(body.signedPrekey)) throw new HttpError(400, "signedPrekey required");
  rejectPrivateFields(body.signedPrekey);
  const signedPrekey: SignedPrekey = {
    keyId: asKeyId(body.signedPrekey.keyId, "signedPrekey.keyId"),
    publicKey: asPublic(body.signedPrekey.publicKey, "signedPrekey.publicKey"),
    signature: asPublic(body.signedPrekey.signature, "signedPrekey.signature"),
  };
  if (!Array.isArray(body.oneTimePrekeys)) throw new HttpError(400, "oneTimePrekeys required");
  if (body.oneTimePrekeys.length > MAX_OTPK) throw new HttpError(400, "too many oneTimePrekeys");
  const seen = new Set<number>();
  const oneTimePrekeys = body.oneTimePrekeys.map((item, index) => {
    if (!isRecord(item)) throw new HttpError(400, `invalid oneTimePrekeys[${index}]`);
    rejectPrivateFields(item);
    const keyId = asKeyId(item.keyId, `oneTimePrekeys[${index}].keyId`);
    if (seen.has(keyId)) throw new HttpError(400, "duplicate oneTimePrekey keyId");
    seen.add(keyId);
    return {
      keyId,
      publicKey: asPublic(item.publicKey, `oneTimePrekeys[${index}].publicKey`),
    };
  });
  return { identityKey, signedPrekey, oneTimePrekeys };
}

/**
 * GET /me
 * Authorization: Bearer session → { user, devices }
 */
export async function getMe(env: Env, userId: string): Promise<unknown> {
  const user = await env.DB.prepare("SELECT id, phone, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; phone: string; created_at: number }>();
  if (!user) throw new HttpError(401, "invalid session");

  const devices = await env.DB.prepare(
    `SELECT id, device_name, created_at, identity_key, bundle_updated_at
     FROM devices WHERE user_id = ? ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<DeviceRow>();

  return {
    user: { id: user.id, phone: user.phone, createdAt: user.created_at },
    devices: devices.results.map((device) => ({
      id: device.id,
      name: device.device_name,
      createdAt: device.created_at,
      identityKey: device.identity_key,
      bundleUpdatedAt: device.bundle_updated_at,
    })),
  };
}

/**
 * POST /devices
 * { name } → device record
 */
export async function createDevice(env: Env, userId: string, body: unknown): Promise<unknown> {
  if (!isRecord(body)) throw new HttpError(400, "invalid body");
  rejectPrivateFields(body);
  const name = asName(body.name);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO devices (id, user_id, device_name, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, name, createdAt)
    .run();
  return { id, userId, name, createdAt };
}

/**
 * PUT /devices/:id/prekey-bundle
 * Stores the public bundle only. Replaces any previous one-time prekeys.
 */
export async function putPrekeyBundle(
  env: Env,
  userId: string,
  deviceId: string,
  body: unknown,
): Promise<unknown> {
  const bundle = parseBundle(body);
  const owned = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, userId)
    .first<{ id: string }>();
  if (!owned) throw new HttpError(404, "device not found");

  const updatedAt = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE devices
       SET identity_key = ?, signed_prekey_id = ?, signed_prekey_public = ?,
           signed_prekey_signature = ?, bundle_updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(
      bundle.identityKey,
      bundle.signedPrekey.keyId,
      bundle.signedPrekey.publicKey,
      bundle.signedPrekey.signature,
      updatedAt,
      deviceId,
      userId,
    ),
    env.DB.prepare("DELETE FROM one_time_prekeys WHERE device_id = ?").bind(deviceId),
    ...bundle.oneTimePrekeys.map((prekey) =>
      env.DB.prepare(
        "INSERT INTO one_time_prekeys (device_id, key_id, public_key, consumed_at) VALUES (?, ?, ?, NULL)",
      ).bind(deviceId, prekey.keyId, prekey.publicKey),
    ),
  ];
  await env.DB.batch(statements);
  return { deviceId, bundleUpdatedAt: updatedAt, oneTimePrekeyCount: bundle.oneTimePrekeys.length };
}

async function takeOneTimePrekey(env: Env, deviceId: string): Promise<OneTimePrekey | null> {
  const row = await env.DB.prepare(
    `UPDATE one_time_prekeys
     SET consumed_at = ?
     WHERE device_id = ?
       AND key_id = (
         SELECT key_id FROM one_time_prekeys
         WHERE device_id = ? AND consumed_at IS NULL
         ORDER BY key_id ASC
         LIMIT 1
       )
     RETURNING key_id, public_key`,
  )
    .bind(Date.now(), deviceId, deviceId)
    .first<{ key_id: number; public_key: string }>();
  if (!row) return null;
  return { keyId: row.key_id, publicKey: row.public_key };
}

/**
 * GET /users/:userId/prekey-bundle
 * Public bundles for session setup. Each call consumes one one-time prekey per device.
 */
export async function getPrekeyBundle(env: Env, userId: string): Promise<unknown> {
  const devices = await env.DB.prepare(
    `SELECT id, identity_key, signed_prekey_id, signed_prekey_public, signed_prekey_signature
     FROM devices
     WHERE user_id = ? AND identity_key IS NOT NULL
     ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<BundleRow>();

  if (devices.results.length === 0) throw new HttpError(404, "no prekey bundle");

  const bundles: Array<{
    deviceId: string;
    identityKey: string;
    signedPrekey: SignedPrekey;
    oneTimePrekey: OneTimePrekey | null;
  }> = [];
  for (const device of devices.results) {
    bundles.push({
      deviceId: device.id,
      identityKey: device.identity_key,
      signedPrekey: {
        keyId: device.signed_prekey_id,
        publicKey: device.signed_prekey_public,
        signature: device.signed_prekey_signature,
      },
      oneTimePrekey: await takeOneTimePrekey(env, device.id),
    });
  }
  return { userId, bundles };
}
