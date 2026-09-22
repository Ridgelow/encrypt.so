import { bytesToBase64 } from "@open-e2ee/signal-protocol-sdk/encoding";
import {
  createCompositeIdentityV1,
  encodeCompositeIdentityV1,
  generateEcOneTimePreKeys,
  generateEcSignedPreKey,
  generateIdentityKeyPair,
  generateKyberLastResortPreKey,
  PREKEY_ALGORITHM_X25519,
  verifyMlKem1024PreKey,
  verifyPreKeySignature,
} from "@open-e2ee/signal-protocol-sdk/keys";
import { ONE_TIME_PREKEY_COUNT, PUBLIC_FIELD_MAX } from "./contract";
import { DeviceKeyGenerationError } from "./errors";
import type { PersistedDeviceKeys } from "./record";

export async function generateDeviceKeyRecord(options?: {
  oneTimePreKeyCount?: number;
  now?: number;
}): Promise<PersistedDeviceKeys> {
  const count = options?.oneTimePreKeyCount ?? ONE_TIME_PREKEY_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > ONE_TIME_PREKEY_COUNT) {
    throw new DeviceKeyGenerationError();
  }

  const identity = await generateIdentityKeyPair();
  const composite = createCompositeIdentityV1(identity);
  const signedPreKey = await generateEcSignedPreKey(identity);
  const oneTimePreKeys = await generateEcOneTimePreKeys(count, 1);
  const kyberPreKey = await generateKyberLastResortPreKey(identity);

  const signedOk = await verifyPreKeySignature(
    composite,
    PREKEY_ALGORITHM_X25519,
    signedPreKey.keyId,
    signedPreKey.publicKey,
    signedPreKey.signature,
  );
  const kyberOk = await verifyMlKem1024PreKey(
    composite,
    kyberPreKey.keyId,
    kyberPreKey.publicKey,
    kyberPreKey.signature,
  );
  if (!signedOk || !kyberOk) throw new DeviceKeyGenerationError();

  const identityPublic = bytesToBase64(encodeCompositeIdentityV1(composite));
  if (identityPublic.length < 8 || identityPublic.length > PUBLIC_FIELD_MAX) {
    throw new DeviceKeyGenerationError();
  }

  return {
    version: 1,
    createdAt: options?.now ?? Date.now(),
    publishedTo: null,
    serverDeviceId: null,
    identity: {
      registrationId: identity.registrationId,
      identityPublic,
      dhPublicKey: identity.dhKey.publicKey,
      dhPrivateKey: identity.dhKey.privateKey,
      signingPublicKey: identity.signingKey.publicKey,
      signingPrivateKey: identity.signingKey.privateKey,
    },
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      privateKey: signedPreKey.privateKey,
      signature: signedPreKey.signature,
      timestamp: signedPreKey.timestamp,
    },
    oneTimePreKeys: oneTimePreKeys.map((prekey) => ({
      keyId: prekey.keyId,
      publicKey: prekey.publicKey,
      privateKey: prekey.privateKey,
    })),
    kyberPreKey: {
      keyId: kyberPreKey.keyId,
      publicKey: kyberPreKey.publicKey,
      privateKey: kyberPreKey.privateKey,
      signature: kyberPreKey.signature,
      timestamp: kyberPreKey.timestamp,
    },
  };
}
