import type { PrekeyBundleUpload } from "@/services/api";
import { ONE_TIME_PREKEY_COUNT, PUBLIC_FIELD_MAX } from "./contract";
import { BundleUploadError } from "./errors";

const PUBLIC_RE = /^[A-Za-z0-9+/=_-]+$/;

function ownKeys(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) ownKeys(item, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      ownKeys(child, found);
    }
  }
}

/**
 * Same checks the worker applies before insert: no `private*` fields, and
 * every public string fits the 512-character column.
 */
export function assertPublicBundle(bundle: PrekeyBundleUpload, secrets: readonly string[]): void {
  const keys: string[] = [];
  ownKeys(bundle, keys);
  if (keys.some((key) => /private/i.test(key))) {
    throw new BundleUploadError(0, "private_key");
  }

  const publics = [
    bundle.identityKey,
    bundle.signedPrekey.publicKey,
    bundle.signedPrekey.signature,
    ...bundle.oneTimePrekeys.map((prekey) => prekey.publicKey),
  ];
  if (bundle.oneTimePrekeys.length < 1 || bundle.oneTimePrekeys.length > ONE_TIME_PREKEY_COUNT) {
    throw new BundleUploadError(0, "invalid_bundle");
  }
  const ids = new Set<number>();
  for (const prekey of bundle.oneTimePrekeys) {
    if (!Number.isInteger(prekey.keyId) || prekey.keyId < 0 || ids.has(prekey.keyId)) {
      throw new BundleUploadError(0, "invalid_bundle");
    }
    ids.add(prekey.keyId);
  }
  if (!Number.isInteger(bundle.signedPrekey.keyId) || bundle.signedPrekey.keyId < 0) {
    throw new BundleUploadError(0, "invalid_bundle");
  }
  for (const value of publics) {
    if (value.length < 8 || value.length > PUBLIC_FIELD_MAX || !PUBLIC_RE.test(value)) {
      throw new BundleUploadError(0, "invalid_bundle");
    }
  }

  const body = JSON.stringify(bundle);
  for (const secret of secrets) {
    if (secret.length > 0 && body.includes(secret)) {
      throw new BundleUploadError(0, "private_key");
    }
  }
}
