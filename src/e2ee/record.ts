import type { PublicKey, Signature } from "@open-e2ee/signal-protocol-sdk/keys";
import type { PrekeyBundleUpload } from "@/services/api";
import { DeviceKeyRecordError } from "./errors";

export const DEVICE_KEY_RECORD_KEY = "encrypt.keys.device";

export interface PersistedDeviceKeys {
  version: 1;
  createdAt: number;
  /** Worker origin this public bundle was last accepted by, or null. */
  publishedTo: string | null;
  /** `POST /devices` id. Null until the device row exists. */
  serverDeviceId: string | null;
  identity: {
    registrationId: number;
    /** CompositeIdentityV1, standard base64. This is the uploaded identityKey. */
    identityPublic: string;
    dhPublicKey: string;
    dhPrivateKey: string;
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  signedPreKey: {
    keyId: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    timestamp: number;
  };
  oneTimePreKeys: Array<{
    keyId: number;
    publicKey: string;
    privateKey: string;
  }>;
  kyberPreKey: {
    keyId: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    timestamp: number;
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !BASE64.test(value)) {
    throw new DeviceKeyRecordError();
  }
  return value;
}

function expectInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DeviceKeyRecordError();
  }
  return value;
}

export function privateMaterial(record: PersistedDeviceKeys): readonly string[] {
  return [
    record.identity.dhPrivateKey,
    record.identity.signingPrivateKey,
    record.signedPreKey.privateKey,
    record.kyberPreKey.privateKey,
    ...record.oneTimePreKeys.map((prekey) => prekey.privateKey),
  ];
}

/** Public fields only, in the worker's `PrekeyBundleUpload` shape. */
export function toPrekeyBundleUpload(record: PersistedDeviceKeys): PrekeyBundleUpload {
  return {
    identityKey: record.identity.identityPublic,
    signedPrekey: {
      keyId: record.signedPreKey.keyId,
      publicKey: record.signedPreKey.publicKey,
      signature: record.signedPreKey.signature,
    },
    oneTimePrekeys: record.oneTimePreKeys.map((prekey) => ({
      keyId: prekey.keyId,
      publicKey: prekey.publicKey,
    })),
  };
}

export function serializeRecord(record: PersistedDeviceKeys): string {
  return JSON.stringify(record);
}

export function parseRecord(raw: string): PersistedDeviceKeys {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceKeyRecordError();
  }
  if (!isRecord(parsed) || parsed.version !== 1) throw new DeviceKeyRecordError();
  if (parsed.publishedTo !== null && typeof parsed.publishedTo !== "string") {
    throw new DeviceKeyRecordError();
  }
  if (parsed.serverDeviceId !== null && typeof parsed.serverDeviceId !== "string") {
    throw new DeviceKeyRecordError();
  }
  if (!isRecord(parsed.identity) || !isRecord(parsed.signedPreKey) || !isRecord(parsed.kyberPreKey)) {
    throw new DeviceKeyRecordError();
  }
  if (!Array.isArray(parsed.oneTimePreKeys)) {
    throw new DeviceKeyRecordError();
  }

  const registrationId = expectInt(parsed.identity.registrationId);
  if (registrationId < 1 || registrationId > 16383) throw new DeviceKeyRecordError();

  return {
    version: 1,
    createdAt: expectInt(parsed.createdAt),
    publishedTo: parsed.publishedTo === null ? null : parsed.publishedTo,
    serverDeviceId: parsed.serverDeviceId === null ? null : parsed.serverDeviceId,
    identity: {
      registrationId,
      identityPublic: expectString(parsed.identity.identityPublic),
      dhPublicKey: expectString(parsed.identity.dhPublicKey),
      dhPrivateKey: expectString(parsed.identity.dhPrivateKey),
      signingPublicKey: expectString(parsed.identity.signingPublicKey),
      signingPrivateKey: expectString(parsed.identity.signingPrivateKey),
    },
    signedPreKey: {
      keyId: expectInt(parsed.signedPreKey.keyId),
      publicKey: expectString(parsed.signedPreKey.publicKey),
      privateKey: expectString(parsed.signedPreKey.privateKey),
      signature: expectString(parsed.signedPreKey.signature),
      timestamp: expectInt(parsed.signedPreKey.timestamp),
    },
    oneTimePreKeys: parsed.oneTimePreKeys.map((prekey) => {
      if (!isRecord(prekey)) throw new DeviceKeyRecordError();
      return {
        keyId: expectInt(prekey.keyId),
        publicKey: expectString(prekey.publicKey),
        privateKey: expectString(prekey.privateKey),
      };
    }),
    kyberPreKey: {
      keyId: expectInt(parsed.kyberPreKey.keyId),
      publicKey: expectString(parsed.kyberPreKey.publicKey),
      privateKey: expectString(parsed.kyberPreKey.privateKey),
      signature: expectString(parsed.kyberPreKey.signature),
      timestamp: expectInt(parsed.kyberPreKey.timestamp),
    },
  };
}

export function asPublicKey(value: string): PublicKey {
  return value as PublicKey;
}

export function asSignature(value: string): Signature {
  return value as Signature;
}
