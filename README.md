# encrypt_

Mobile E2EE messenger for **encrypt.so**, styled with the BLACKOUT brand kit.

## Run

```bash
npm install --legacy-peer-deps
npx expo start
```

Then open in Expo Go (iOS/Android) or press `i` / `a` for simulators.

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

Sessions, websockets, and attachments are not in this change.

## Notes

- Chat and attachments are still local mock UI. Durable Objects, R2, and push are not in this tree yet.
- Wordmark face **Hacked** by David Libeau (CC-BY) — credit required wherever this ships.
- See `PROJECT.md` for stack and brand decisions.
