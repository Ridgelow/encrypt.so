# Two-device QA — encrypt_

Checklist for a development-client pass after Sender Keys. Store credentials stay in EAS. Do not commit `.env`, `EXPO_TOKEN`, `EXPO_ACCESS_TOKEN`, or Play / App Store keys.

## Deploy first

From `workers/`, against the remote D1 database the app will call:

```bash
npx wrangler d1 migrations apply encrypt-so --remote
npx wrangler deploy
```

Confirm these are applied before anyone registers:

- `0004_retention.sql` — `attachment_objects` plus message retention indexes (`expire_at` stays the disappearing-message deadline).
- `0005_groups.sql` — `conversations.kind` and `conversations.title` for Sender Keys groups.
- Durable Object migration tag `v2` in `workers/wrangler.toml` — `UserGate` (`USER_GATES`). This is the per-user socket cap, not an inbox. `ConversationRoom` is tag `v1`. `wrangler deploy` applies a tag that is not already on the script.

Create the remote R2 bucket `encrypt-so-attachments` if this environment does not have it yet. Placeholder ids in `wrangler.toml` must already be replaced for that deploy.

Push is metadata only (`New message`, `conversationId`, `unread: true`). No message text in the payload.

- Worker secret set: `npx wrangler secret put EXPO_ACCESS_TOKEN` (do not write the value into git). A send should raise a notification on the other device.
- Secret unset: the worker logs `push stub count=… reason=missing EXPO_ACCESS_TOKEN` and does not call `exp.host`. The message is still in the thread.

## Install the Android dev client

The green artifact is the `development` profile (dev client, internal distribution), not the preview APK and not a Play bundle.

```bash
npm run build:development -- --platform android
```

Install that APK from the EAS build page on both phones. Copy `.env.example` to `.env` (untracked) and set `EXPO_PUBLIC_API_URL` to the deployed worker origin, no trailing slash. Start Metro where both phones can reach it:

```bash
npx expo start --dev-client
```

Use `--tunnel` when the phones are not on the same LAN. Open the project from the dev-client launcher on each phone. The same origin must be in the bundle both devices load.

## Register two users

On each phone: Get Started → phone number → Continue → code `000000` → Verify. Use two different numbers (the worker stores one user per E.164 number). Wait through key generation until public keys upload. Continue past profile setup to Messages.

Mock rows (Sam, Alex, Design Crit) stay on the device. They are not the encrypted path.

User ids are not shown on the profile screen. Read them from D1:

```bash
npx wrangler d1 execute encrypt-so --remote \
  --command "SELECT id, phone FROM users ORDER BY created_at DESC LIMIT 10;"
```

Each `id` is a UUID. Devices need a prekey bundle before the other phone can start a session (`devices.identity_key` is set after keygen).

The Messages list does not list live threads. Open one with the app scheme:

- 1:1: `encryptso://conversation/<peer-user-id>`
- Group: `encryptso://conversation/<group-id>?group=1`

## Checklist

- [ ] **1:1 send / receive.** On phone A, open `encryptso://conversation/<B's user id>`. Send a short line. On phone B, open `encryptso://conversation/<A's user id>`. B sees A's plaintext. Reply from B and confirm A decrypts it. A failed send shows `!` on the bubble.

- [ ] **Safety number.** In that 1:1 thread, tap the lock (Safety number). Both phones show the same 12 groups of five digits. Tap Mark as Verified on each. The row reads Verified. A mock chat (no peer UUID) stays on "No encrypted session".

- [ ] **Realtime.** Leave both 1:1 threads open. Send from A. The line shows on B without leaving the screen or reloading. Header reads "End-to-end encrypted".

- [ ] **Attachment.** Tap Attach → Photo or File (Location does nothing). A uploads ciphertext to R2 and sends an `attachment/v1` envelope. B sees an attachment row, not the content-key JSON, and can open the decrypted file. A failed upload shows `!`.

- [ ] **Push, metadata only.** Allow notifications on B, then background B. Send from A. With `EXPO_ACCESS_TOKEN` set, B gets a notification titled `New message` and the body is not the plaintext. Without the secret, confirm the worker log line `push stub` and that reopening the thread still shows the message.

- [ ] **Group + Sender Keys.** Do this after the 1:1 checks. A live group needs the creator plus two other accounts (`memberUserIds` length at least 2). There is no sign-out control: on phone A, clear app storage, register a third number, and wait for keygen. Clear storage again and register A's original number (same user id; keygen runs again). On A: New message → New Group → name → Member user id for B and for the third account → Add → Create Group. The header shows a member count, not "4 members". Send a line. On B, open `encryptso://conversation/<group id>?group=1` (group id from `SELECT id, title, kind FROM conversations ORDER BY created_at DESC LIMIT 5`). B decrypts it. "Message unavailable" means the sender-key distribution did not land. Removing a member is not in v1.

- [ ] **Disappearing messages.** In a live thread, tap Disappearing messages and choose **30 seconds**. The hint reads "Disappearing messages: 30 seconds". Send. The bubble leaves both devices after 30 seconds and does not return when the thread is opened again. Other choices: Off, 5 minutes, 1 hour, 1 day, 1 week.

## Store submit

After this pass, store builds use the `production` profile (AAB / IPA). Scripts do not prompt and do not read secrets from the repo:

```bash
npm run submit:ios                 # TestFlight
npm run submit:android:internal    # Play internal track
npm run submit:android             # Play production track
```

`submit:ios` uploads to TestFlight. App Store review is the manual promote in App Store Connect. If `--latest` on the internal script selects the preview APK, pass the production build id instead: `npx eas-cli submit --platform android --profile preview --id <build-id> --non-interactive`.
