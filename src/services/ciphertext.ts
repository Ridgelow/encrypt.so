import { base64ToBytes, bytesToBase64 } from "@open-e2ee/signal-protocol-sdk/encoding";
import type { OpaqueEnvelope } from "@/e2ee/session";
import type { CiphertextMessage, MessagingClient, PostMessageInput } from "@/services/api";
import { decodeOpaqueEnvelope } from "@/services/realtime";

/** Opaque envelope bytes. The worker stores this string and does not decode it. */
export const ENVELOPE_CONTENT_TYPE = "application/vnd.encrypt.envelope";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEnvelope(value: unknown): value is OpaqueEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as OpaqueEnvelope;
  return (
    envelope.version === 1 &&
    typeof envelope.senderUserId === "string" &&
    typeof envelope.senderDeviceId === "string" &&
    typeof envelope.recipientUserId === "string" &&
    typeof envelope.recipientDeviceId === "string" &&
    typeof envelope.ciphertext === "string" &&
    envelope.ciphertext.length >= 8
  );
}

/** Standard-base64 JSON envelope. Plaintext is not part of this encoding. */
export function envelopeToCiphertext(envelope: OpaqueEnvelope): string {
  const json = JSON.stringify({
    version: envelope.version,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    recipientUserId: envelope.recipientUserId,
    recipientDeviceId: envelope.recipientDeviceId,
    ciphertext: envelope.ciphertext,
  });
  return bytesToBase64(new TextEncoder().encode(json));
}

/**
 * Read an opaque envelope stored either as the Signal SDK base64 JSON
 * (`envelopeToCiphertext`) or the realtime frame encoding.
 */
export function readOpaqueCiphertext(ciphertext: string): OpaqueEnvelope | null {
  try {
    return ciphertextToEnvelope(ciphertext);
  } catch {
    return decodeOpaqueEnvelope(ciphertext);
  }
}

export function ciphertextToEnvelope(ciphertext: string): OpaqueEnvelope {
  let json: string;
  try {
    json = new TextDecoder().decode(base64ToBytes(ciphertext as Parameters<typeof base64ToBytes>[0]));
  } catch {
    throw new Error("ciphertext is not an envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error("ciphertext is not an envelope");
  }
  if (!isEnvelope(parsed)) throw new Error("ciphertext is not an envelope");
  return parsed;
}

/**
 * Body for `POST /conversations/:id/messages`.
 * `expireAt` is unix milliseconds. Omit it when the message does not disappear.
 */
export function postBodyForEnvelope(
  envelope: OpaqueEnvelope,
  options: { clientId: string; expireAt?: number },
): PostMessageInput {
  const body: PostMessageInput = {
    ciphertext: envelopeToCiphertext(envelope),
    contentType: ENVELOPE_CONTENT_TYPE,
    clientId: options.clientId,
  };
  if (UUID.test(envelope.senderDeviceId)) body.senderDeviceId = envelope.senderDeviceId;
  if (typeof options.expireAt === "number") body.expireAt = options.expireAt;
  return body;
}

/**
 * Create the 1:1 conversation if needed and store the opaque envelope.
 * Callers pass an envelope, never plaintext.
 */
export async function sendDisappearingCiphertext(input: {
  client: Pick<MessagingClient, "createConversation" | "postMessage">;
  token: string;
  peerUserId: string;
  envelope: OpaqueEnvelope;
  clientId: string;
  expireAt?: number;
}): Promise<CiphertextMessage> {
  const conversation = await input.client.createConversation(input.token, input.peerUserId);
  return input.client.postMessage(
    input.token,
    conversation.id,
    postBodyForEnvelope(input.envelope, { clientId: input.clientId, expireAt: input.expireAt }),
  );
}
