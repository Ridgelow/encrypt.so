# encrypt_

Mobile E2EE messenger for **encrypt.so**, styled with the BLACKOUT brand kit.

## Run

```bash
npm install --legacy-peer-deps
npx expo start
```

Then open in Expo Go (iOS/Android) or press `i` / `a` for simulators. After `expo-dev-client` is installed, `npx expo start` targets a development build; pass `--go` to keep using Expo Go.

## Ship

EAS profiles are in `eas.json`. Identity stays `encrypt_` / slug `encrypt-so` / scheme `encryptso` / bundle id and package `so.encrypt.app`.

```bash
npm run build:development   # dev client, internal (device)
npm run build:preview       # internal distribution (Android APK)
npm run build:production    # store
```

The first `eas build` links an Expo project (`eas login`). Do not commit credentials, `.env`, or Cloudflare tokens.

## Frontend map

Mockups → Expo Router screens under `src/app/`:

| Mockup | Route |
| --- | --- |
| Splash | `/` |
| Welcome | `/welcome` |
| Phone entry | `/phone` |
| Verify code | `/verify` |
| Key generation | `/keygen` |
| Profile setup | `/profile` |
| Chat list | `/chats` |
| Conversation | `/conversation/[id]` |
| Safety number | `/safety/[id]` |
| New message | `/new-chat` |
| New group | `/new-group` |

Sheets (attachments, disappearing timer) open as modals from the conversation screen.

## API

Auth and public prekey bundles live in [`workers/`](workers/README.md). Point the app at a running worker with `EXPO_PUBLIC_API_URL` (see `.env.example`). Phone entry and verify call that API. The SMS stub accepts code `000000`. If the worker is down or the variable is unset, those screens continue offline.

## Device keys

The key-generation screen calls `provisionDeviceKeys()` (`src/e2ee`). It uses `@open-e2ee/signal-protocol-sdk` to generate an identity (X25519 + Ed25519), a signed prekey, 100 one-time prekeys, and a local ML-KEM-1024 last-resort prekey. Private keys are written only to `expo-secure-store`, chunked under the historical ~2KB iOS value limit, and are never logged.

With a verified session and `EXPO_PUBLIC_API_URL`, the client `POST`s `/devices` and `PUT`s `/devices/:id/prekey-bundle`. The uploaded `identityKey` is the SDK's CompositeIdentityV1 public blob. The KEM prekey stays on device: its public key is longer than the worker's 512-character public-field limit. If the worker or Secure Store is unavailable, the existing onboarding animation still continues.

Key generation and `expo-crypto` / `expo-secure-store` are included in Expo Go. Expo Metro selects the SDK's `react-native` random source (`globalThis.crypto`, then `expo-crypto`). The SDK's SQLCipher store is not wired up and would need a development build.

## 1:1 sessions

`ensureSessionWithUser`, `encryptForPeer`, and `decryptFromPeer` (`src/e2ee`) turn plaintext into an opaque base64 envelope and back. Establishing a session calls `GET /users/:userId/prekey-bundle`, picks one device, and runs the SDK's X3DH initiator path. The worker still does not publish the ML-KEM prekey, so that fetch uses the SDK's classical compatibility path. A bundle that includes KEM material takes PQXDH. The first incoming prekey message establishes the responder session from the keys already in Secure Store. Session records stay on device.

The conversation screen encrypts a send when the route id is a real user id, and decrypts a sealed incoming envelope when one is present. Mock chats (Sam, groups) stay local if there is no session. WebSockets, Durable Objects, and attachments are still out of scope — nothing here puts plaintext on an API.

## Notes

- Mock chats stay on the device. A conversation opened with a real user id encrypts locally, but Durable Objects, R2, and push are not in this tree yet.
- Wordmark face **Hacked** by David Libeau (CC-BY) — credit required wherever this ships.
- See `PROJECT.md` for stack and brand decisions.
