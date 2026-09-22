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

## Notes

- UI is frontend-only with mock data — Signal Protocol + Cloudflare backend come next.
- Wordmark face **Hacked** by David Libeau (CC-BY) — credit required wherever this ships.
- See `PROJECT.md` for stack and brand decisions.
