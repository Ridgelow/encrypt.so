import { base64ToBytes, bytesToBase64 } from "@open-e2ee/signal-protocol-sdk/encoding";
import type { OpaqueEnvelope } from "./session";
import { GroupMessageError } from "./errors";

/** One Sender Keys frame, shared by every member. The worker stores this as opaque ciphertext. */
export const SENDER_KEY_CONTENT_TYPE = "application/vnd.encrypt.sender-key";

/** A 1:1 envelope carrying a SenderKeyDistributionMessage for one member. */
export const SENDER_KEY_DIST_CONTENT_TYPE = "application/vnd.encrypt.sk-dist";

export interface GroupSenderPayload {
  version: 1;
  kind: "sender-key";
  groupId: string;
  senderUserId: string;
  protocolDeviceId: number;
  /** SDK SenderKeyMessage bytes, standard base64. */
  frame: string;
}

export interface GroupDistributionPayload {
  version: 1;
  kind: "sender-key-distribution";
  groupId: string;
  protocolDeviceId: number;
  envelope: OpaqueEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJson(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(ciphertext: string): unknown {
  let json: string;
  try {
    json = new TextDecoder().decode(base64ToBytes(ciphertext as Parameters<typeof base64ToBytes>[0]));
  } catch {
    throw new GroupMessageError();
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new GroupMessageError();
  }
}

function isEnvelope(value: unknown): value is OpaqueEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.senderUserId === "string" &&
    typeof value.senderDeviceId === "string" &&
    typeof value.recipientUserId === "string" &&
    typeof value.recipientDeviceId === "string" &&
    typeof value.ciphertext === "string" &&
    value.ciphertext.length >= 8
  );
}

export function encodeGroupSender(payload: GroupSenderPayload): string {
  return encodeJson({
    version: 1,
    kind: "sender-key",
    groupId: payload.groupId,
    senderUserId: payload.senderUserId,
    protocolDeviceId: payload.protocolDeviceId,
    frame: payload.frame,
  });
}

export function encodeGroupDistribution(payload: GroupDistributionPayload): string {
  return encodeJson({
    version: 1,
    kind: "sender-key-distribution",
    groupId: payload.groupId,
    protocolDeviceId: payload.protocolDeviceId,
    envelope: {
      version: payload.envelope.version,
      senderUserId: payload.envelope.senderUserId,
      senderDeviceId: payload.envelope.senderDeviceId,
      recipientUserId: payload.envelope.recipientUserId,
      recipientDeviceId: payload.envelope.recipientDeviceId,
      ciphertext: payload.envelope.ciphertext,
    },
  });
}

export function decodeGroupSender(ciphertext: string): GroupSenderPayload {
  const parsed = decodeJson(ciphertext);
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.kind !== "sender-key") throw new GroupMessageError();
  if (typeof parsed.groupId !== "string" || typeof parsed.senderUserId !== "string") throw new GroupMessageError();
  if (typeof parsed.protocolDeviceId !== "number" || !Number.isInteger(parsed.protocolDeviceId) || parsed.protocolDeviceId < 1) {
    throw new GroupMessageError();
  }
  if (typeof parsed.frame !== "string" || parsed.frame.length < 8) throw new GroupMessageError();
  return {
    version: 1,
    kind: "sender-key",
    groupId: parsed.groupId,
    senderUserId: parsed.senderUserId,
    protocolDeviceId: parsed.protocolDeviceId,
    frame: parsed.frame,
  };
}

export function decodeGroupDistribution(ciphertext: string): GroupDistributionPayload {
  const parsed = decodeJson(ciphertext);
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.kind !== "sender-key-distribution") {
    throw new GroupMessageError();
  }
  if (typeof parsed.groupId !== "string") throw new GroupMessageError();
  if (typeof parsed.protocolDeviceId !== "number" || !Number.isInteger(parsed.protocolDeviceId) || parsed.protocolDeviceId < 1) {
    throw new GroupMessageError();
  }
  if (!isEnvelope(parsed.envelope)) throw new GroupMessageError();
  return {
    version: 1,
    kind: "sender-key-distribution",
    groupId: parsed.groupId,
    protocolDeviceId: parsed.protocolDeviceId,
    envelope: parsed.envelope,
  };
}
