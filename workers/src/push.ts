import { enforceLimit, sessionsKv } from "./abuse";
import { loadGuardConfig } from "./guard";
import { HttpError } from "./http";
import {
  EXPO_PUSH_TOKEN_RE,
  buildNewMessagePush,
  deliverExpoPushes,
  parsePushRegistration,
  parsePushUnregister,
} from "./push-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /push/register
 * { expoPushToken, platform, deviceId? } → { registered: true }
 * Upserts the installation token for the signed-in user.
 */
export async function registerPushToken(
  env: Env,
  userId: string,
  body: unknown,
  scope?: { ip?: string },
): Promise<{ registered: true }> {
  const registration = parsePushRegistration(body);
  const config = loadGuardConfig(env);
  const kv = sessionsKv(env);
  if (scope?.ip) {
    await enforceLimit(kv, `rl:v1:push:ip:${scope.ip}`, config.pushPerIp, config.pushWindowMs);
  }
  await enforceLimit(kv, `rl:v1:push:user:${userId}`, config.pushPerUser, config.pushWindowMs);
  if (registration.deviceId) {
    const owned = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?")
      .bind(registration.deviceId, userId)
      .first<{ id: string }>();
    if (!owned) throw new HttpError(404, "device not found");
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO push_tokens (expo_push_token, user_id, device_id, platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(expo_push_token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       device_id = CASE
         WHEN excluded.user_id != push_tokens.user_id THEN excluded.device_id
         ELSE COALESCE(excluded.device_id, push_tokens.device_id)
       END,
       updated_at = excluded.updated_at`,
  )
    .bind(
      registration.expoPushToken,
      userId,
      registration.deviceId,
      registration.platform,
      now,
      now,
    )
    .run();
  return { registered: true };
}

/**
 * POST /push/unregister
 * { expoPushToken } → { unregistered: true }
 * Deletes the token only when it belongs to the signed-in user.
 */
export async function unregisterPushToken(
  env: Env,
  userId: string,
  body: unknown,
  scope?: { ip?: string },
): Promise<{ unregistered: true }> {
  const expoPushToken = parsePushUnregister(body);
  const config = loadGuardConfig(env);
  const kv = sessionsKv(env);
  if (scope?.ip) {
    await enforceLimit(kv, `rl:v1:push:ip:${scope.ip}`, config.pushPerIp, config.pushWindowMs);
  }
  await enforceLimit(kv, `rl:v1:push:user:${userId}`, config.pushPerUser, config.pushWindowMs);
  await env.DB.prepare("DELETE FROM push_tokens WHERE expo_push_token = ? AND user_id = ?")
    .bind(expoPushToken, userId)
    .run();
  return { unregistered: true };
}

/**
 * After a new message row is stored, notify the other members.
 * The payload is a conversation id and an unread flag. The stored row is not read.
 */
export async function notifyNewMessage(
  env: Env,
  input: { conversationId: string; senderUserId: string },
): Promise<void> {
  if (!UUID.test(input.conversationId) || !UUID.test(input.senderUserId)) return;
  const rows = await env.DB.prepare(
    `SELECT t.expo_push_token AS token
     FROM push_tokens t
     INNER JOIN memberships m ON m.user_id = t.user_id AND m.conversation_id = ?
     WHERE t.user_id != ?`,
  )
    .bind(input.conversationId, input.senderUserId)
    .all<{ token: string }>();

  const messages = [];
  for (const row of rows.results) {
    if (!EXPO_PUSH_TOKEN_RE.test(row.token)) continue;
    messages.push(buildNewMessagePush(row.token, input.conversationId));
  }
  const delivery = await deliverExpoPushes({
    accessToken: env.EXPO_ACCESS_TOKEN,
    messages,
  });
  if (delivery.droppedTokens.length === 0) return;
  await env.DB.batch(
    delivery.droppedTokens.map((token) =>
      env.DB.prepare("DELETE FROM push_tokens WHERE expo_push_token = ?").bind(token),
    ),
  );
}
