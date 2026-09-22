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

## Notes

- Chat, key generation, and attachments are still local mock UI. Signal Protocol, Durable Objects, R2, and push are not in this tree yet.
- Wordmark face **Hacked** by David Libeau (CC-BY) — credit required wherever this ships.
- See `PROJECT.md` for stack and brand decisions.
