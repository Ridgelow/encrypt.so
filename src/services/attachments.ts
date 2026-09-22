import { sealAttachment } from "@/e2ee/attachment";
import type { OpaqueEnvelope } from "@/e2ee";
import type { MessagingClient } from "@/services/api";

/**
 * Encrypt a file and PUT only the AES-GCM ciphertext.
 * The returned Signal envelope is what `live.publish` or `postMessage` sends.
 * `label` is safe to cache. It is not the content key.
 */
export async function stageEncryptedAttachment(input: {
  client: Pick<MessagingClient, "createAttachmentUpload" | "uploadAttachment">;
  token: string;
  conversationId: string;
  bytes: Uint8Array;
  mime?: string;
  name?: string;
  /** Disappearing-message deadline. Omitted when the timer is off. */
  expireAt?: number | null;
  encrypt: (plaintext: string) => Promise<OpaqueEnvelope>;
}): Promise<{ envelope: OpaqueEnvelope; label: string; objectKey: string }> {
  const grant = await input.client.createAttachmentUpload(
    input.token,
    input.conversationId,
    typeof input.expireAt === "number" ? input.expireAt : undefined,
  );
  const sealed = await sealAttachment({
    bytes: input.bytes,
    mime: input.mime,
    name: input.name,
    objectKey: grant.objectKey,
    encrypt: input.encrypt,
  });
  await input.client.uploadAttachment(grant.uploadUrl, sealed.ciphertextBytes);
  const label = input.name?.split(/[/\\]/).pop()?.replace(/[\u0000-\u001f]/g, "").trim() || (input.mime?.startsWith("image/") ? "Photo" : "File");
  return { envelope: sealed.envelope, label: label.slice(0, 120), objectKey: grant.objectKey };
}
