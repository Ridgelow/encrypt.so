import type { OpaqueEnvelope } from "./session";

/**
 * Wire form of a 1:1 Signal envelope: standard base64 of the versioned JSON.
 * This is the `ciphertext` string stored on a message and the string a
 * realtime frame would carry. It is not the file bytes.
 */
export function encodeOpaqueEnvelope(envelope: OpaqueEnvelope): string {
  const json = JSON.stringify({
    version: envelope.version,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    recipientUserId: envelope.recipientUserId,
    recipientDeviceId: envelope.recipientDeviceId,
    ciphertext: envelope.ciphertext,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

export function decodeOpaqueEnvelope(ciphertext: string): OpaqueEnvelope | null {
  try {
    const binary = atob(ciphertext);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OpaqueEnvelope>;
    if (
      parsed.version !== 1 ||
      typeof parsed.senderUserId !== "string" ||
      typeof parsed.senderDeviceId !== "string" ||
      typeof parsed.recipientUserId !== "string" ||
      typeof parsed.recipientDeviceId !== "string" ||
      typeof parsed.ciphertext !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      senderUserId: parsed.senderUserId,
      senderDeviceId: parsed.senderDeviceId,
      recipientUserId: parsed.recipientUserId,
      recipientDeviceId: parsed.recipientDeviceId,
      ciphertext: parsed.ciphertext,
    };
  } catch {
    return null;
  }
}
