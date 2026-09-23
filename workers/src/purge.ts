import { loadGuardConfig, retentionFloor } from "./guard";

const BATCH = 100;

type PointerRow = { object_key: string; conversation_id: string };

/**
 * Delete ciphertext rows past their disappearing `expire_at` or the server
 * ceiling (`created_at + MESSAGE_TTL_MS`). Attachment pointers use the same
 * ceiling, or a sooner `expire_at` when the upload grant carried one.
 * Object bytes are removed from R2. Nothing here is logged.
 */
export async function purgeExpired(env: Env, now = Date.now()): Promise<void> {
  const floor = retentionFloor(now, loadGuardConfig(env).messageTtlMs);
  await env.DB.prepare("DELETE FROM messages WHERE expire_at IS NOT NULL AND expire_at <= ?").bind(now).run();
  if (floor > 0) {
    await env.DB.prepare("DELETE FROM messages WHERE created_at <= ?").bind(floor).run();
  }
  await purgeAttachmentPointers(env, now);
}

export async function purgeConversation(env: Env, conversationId: string, now = Date.now()): Promise<void> {
  const floor = retentionFloor(now, loadGuardConfig(env).messageTtlMs);
  await env.DB.prepare(
    "DELETE FROM messages WHERE conversation_id = ? AND expire_at IS NOT NULL AND expire_at <= ?",
  )
    .bind(conversationId, now)
    .run();
  if (floor > 0) {
    await env.DB.prepare("DELETE FROM messages WHERE conversation_id = ? AND created_at <= ?")
      .bind(conversationId, floor)
      .run();
  }
  await purgeAttachmentPointers(env, now, conversationId);
}

async function purgeAttachmentPointers(env: Env, now: number, conversationId?: string): Promise<void> {
  const rows = conversationId
    ? await env.DB.prepare(
        `SELECT object_key, conversation_id FROM attachment_objects
         WHERE conversation_id = ? AND expire_at IS NOT NULL AND expire_at <= ?
         LIMIT ?`,
      )
        .bind(conversationId, now, BATCH)
        .all<PointerRow>()
    : await env.DB.prepare(
        `SELECT object_key, conversation_id FROM attachment_objects
         WHERE expire_at IS NOT NULL AND expire_at <= ?
         LIMIT ?`,
      )
        .bind(now, BATCH)
        .all<PointerRow>();
  if (rows.results.length === 0) return;
  await Promise.all(
    rows.results.map(async (row) => {
      try {
        await env.ATTACHMENTS.delete(`${row.conversation_id}/${row.object_key}`);
      } catch {
        console.error("attachment delete failed");
      }
    }),
  );
  const keys = rows.results.map((row) => row.object_key);
  const placeholders = keys.map(() => "?").join(", ");
  await env.DB.prepare(`DELETE FROM attachment_objects WHERE object_key IN (${placeholders})`)
    .bind(...keys)
    .run();
}
