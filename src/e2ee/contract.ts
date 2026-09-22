/**
 * Device key upload uses the Auth worker routes already implemented in
 * `src/services/api.ts` and `workers/src/identity.ts`.
 *
 * ## Session
 *
 * Phone verify (`POST /auth/phone/verify`, stub code `000000`) returns
 * `{ sessionToken, userId }`. The app stores that pair in Secure Store
 * (`src/services/session.ts`) before this module runs.
 *
 * ## Register this device
 *
 * `POST /devices` with `Authorization: Bearer <sessionToken>`
 *
 * ```json
 * { "name": "primary" }
 * ```
 *
 * ```json
 * { "id": "<uuid>", "userId": "<uuid>", "name": "primary", "createdAt": 0 }
 * ```
 *
 * ## Upload public prekeys
 *
 * `PUT /devices/:id/prekey-bundle`
 *
 * Body is `PrekeyBundleUpload`. The worker rejects any field whose name
 * matches `/private/i`, and each public string must be 8–512 characters.
 *
 * ```json
 * {
 *   "identityKey": "<standard base64>",
 *   "signedPrekey": { "keyId": 1, "publicKey": "<base64>", "signature": "<base64>" },
 *   "oneTimePrekeys": [{ "keyId": 1, "publicKey": "<base64>" }]
 * }
 * ```
 *
 * Success:
 *
 * ```json
 * { "deviceId": "<uuid>", "bundleUpdatedAt": 0, "oneTimePrekeyCount": 100 }
 * ```
 *
 * `identityKey` is the canonical CompositeIdentityV1 blob from
 * `@open-e2ee/signal-protocol-sdk` (67 bytes: version, X25519 public key,
 * Ed25519 public key), standard-base64 encoded. That is the whole public
 * identity. The X25519 and Ed25519 private keys stay on device.
 *
 * The worker does not store a registration id or an ML-KEM prekey. The
 * ML-KEM-1024 public key is 1,569 bytes (~2,092 base64 characters), which
 * the 512-character public-field limit rejects, so the last-resort KEM
 * prekey is generated and kept in Secure Store for a later bundle revision.
 *
 * ## Fetch a peer bundle
 *
 * `GET /users/:userId/prekey-bundle` returns
 * `{ userId, bundles: PublicPrekeyBundle[] }` and consumes one one-time
 * prekey per device. Session setup is not implemented in this change.
 */

import type { PrekeyBundleUpload } from "@/services/api";

/** Matches `workers/src/identity.ts` `asPublic` (8–512 characters). */
export const PUBLIC_FIELD_MAX = 512;

/** Matches `MAX_OTPK` on the worker. */
export const ONE_TIME_PREKEY_COUNT = 100;

export const PRIMARY_DEVICE_NAME = "primary";

export type { PrekeyBundleUpload };
