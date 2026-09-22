# encrypt.so API

Cloudflare Worker for auth, public identity, ciphertext persistence, encrypted attachment blobs, and realtime delivery of opaque envelopes. SMS is stubbed: every challenge accepts code `000000`. No private keys and no plaintext messages are stored.

## Bindings

| Binding | Type | Name | Used for |
| --- | --- | --- | --- |
| `DB` | D1 | `encrypt-so` | users, devices, public prekey bundles, conversations, memberships, ciphertext |
| `SESSIONS` | KV | (namespace you create) | phone challenges, session tokens, rate-limit counters, blocklist keys |
| `CONVERSATIONS` | Durable Object | `ConversationRoom` | one object per 1:1 conversation; live WebSocket fan-out |
| `USER_GATES` | Durable Object | `UserGate` | per-user cap on open sockets across conversations. Not a message inbox |
| `ATTACHMENTS` | R2 | `encrypt-so-attachments` | AES-GCM ciphertext blobs. No filenames. |

`wrangler.toml` ships with placeholder IDs. Local `wrangler dev` ignores them and uses local D1, KV, and a simulated R2 bucket. Replace the IDs before `wrangler deploy`.

## First-time setup

```bash
cd workers
npm install
npx wrangler login
npx wrangler d1 create encrypt-so
npx wrangler kv namespace create SESSIONS
npx wrangler r2 bucket create encrypt-so-attachments
```

Copy the printed `database_id` into `wrangler.toml` → `[[d1_databases]].database_id`.
Copy the printed namespace `id` into `[[kv_namespaces]].id`.

Apply the schema, then run or deploy:

```bash
npx wrangler d1 migrations apply encrypt-so --local    # wrangler dev
npx wrangler d1 migrations apply encrypt-so --remote   # deployed worker
npx wrangler dev                                       # http://127.0.0.1:8787
npx wrangler deploy
```

Regenerate binding types after editing `wrangler.toml`:

```bash
npx wrangler types
npm run typecheck
```

## Curl smoke

From a second terminal while `wrangler dev` is running. The verify code is always `000000`. `GET /users/:userId/prekey-bundle` consumes one one-time prekey per device.

```bash
BASE=http://127.0.0.1:8787

CHALLENGE=$(curl -s -X POST "$BASE/auth/phone/start" \
  -H 'content-type: application/json' \
  -d '{"phone":"+15550100192"}' | jq -r .challengeId)

AUTH=$(curl -s -X POST "$BASE/auth/phone/verify" \
  -H 'content-type: application/json' \
  -d "{\"challengeId\":\"$CHALLENGE\",\"code\":\"000000\"}")

TOKEN=$(echo "$AUTH" | jq -r .sessionToken)
USER=$(echo "$AUTH" | jq -r .userId)

curl -s "$BASE/me" -H "authorization: Bearer $TOKEN"

DEVICE=$(curl -s -X POST "$BASE/devices" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"primary"}' | jq -r .id)

curl -s -X PUT "$BASE/devices/$DEVICE/prekey-bundle" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "identityKey": "aWRlbnRpdHkta2V5LXBsYWNlaG9sZGVy",
    "signedPrekey": {
      "keyId": 1,
      "publicKey": "c2lnbmVkLXByZWtleS1wdWJsaWM",
      "signature": "c2lnbmF0dXJlLXBsYWNlaG9sZGVy"
    },
    "oneTimePrekeys": [
      { "keyId": 1, "publicKey": "b25lLXRpbWUtcHVla2V5LTE" }
    ]
  }'

curl -s "$BASE/users/$USER/prekey-bundle" -H "authorization: Bearer $TOKEN"
```

The start handler also prints `sms stub challenge=… code=000000` to the worker log.

### Conversations and ciphertext

Creates a 1:1 conversation, stores one opaque ciphertext, then lists it. The worker does not decode the blob. A second `POST /conversations` with the same pair returns the existing conversation. With one registered device, `senderDeviceId` can be omitted.

```bash
BASE=http://127.0.0.1:8787

ALICE_CHALLENGE=$(curl -s -X POST "$BASE/auth/phone/start" \
  -H 'content-type: application/json' \
  -d '{"phone":"+15550100201"}' | jq -r .challengeId)
ALICE=$(curl -s -X POST "$BASE/auth/phone/verify" \
  -H 'content-type: application/json' \
  -d "{\"challengeId\":\"$ALICE_CHALLENGE\",\"code\":\"000000\"}")
ALICE_TOKEN=$(echo "$ALICE" | jq -r .sessionToken)

BOB_CHALLENGE=$(curl -s -X POST "$BASE/auth/phone/start" \
  -H 'content-type: application/json' \
  -d '{"phone":"+15550100202"}' | jq -r .challengeId)
BOB=$(curl -s -X POST "$BASE/auth/phone/verify" \
  -H 'content-type: application/json' \
  -d "{\"challengeId\":\"$BOB_CHALLENGE\",\"code\":\"000000\"}")
BOB_TOKEN=$(echo "$BOB" | jq -r .sessionToken)
BOB_ID=$(echo "$BOB" | jq -r .userId)

curl -s -X POST "$BASE/devices" \
  -H "authorization: Bearer $ALICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"primary"}' >/dev/null

CONVO=$(curl -s -X POST "$BASE/conversations" \
  -H "authorization: Bearer $ALICE_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"peerUserId\":\"$BOB_ID\"}")
CONVO_ID=$(echo "$CONVO" | jq -r .id)

# Opaque base64. The worker stores this string and does not decode it.
CIPHERTEXT='b3BhcXVlLWNpcGhlcnRleHQtYmxvYg=='

curl -s -X POST "$BASE/conversations/$CONVO_ID/messages" \
  -H "authorization: Bearer $ALICE_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"ciphertext\":\"$CIPHERTEXT\",\"contentType\":\"application/octet-stream\",\"clientId\":\"msg-1\"}"

curl -s "$BASE/conversations/$CONVO_ID/messages?limit=20" \
  -H "authorization: Bearer $BOB_TOKEN" \
  | jq -e --arg c "$CIPHERTEXT" '.messages[0].ciphertext == $c and (.messages[0] | has("plaintext") | not)'

curl -s "$BASE/conversations" -H "authorization: Bearer $ALICE_TOKEN"
```

A body field named `plaintext`, `text`, `body`, `message`, or `content` is rejected with 400. `clientId` retries return the original row. `senderDeviceId` is required only when the sender has more than one device. `expireAt` (unix milliseconds) is the disappearing-message deadline and hides the row from later lists. A separate server ceiling (`MESSAGE_TTL_MS`, from `created_at`) deletes rows even when `expireAt` was omitted. The ceiling is not written back into `expireAt`.

## Realtime

One **Durable Object per conversation id**. Both members open a WebSocket into that object, so delivering an envelope is a broadcast inside the object. A per-user inbox would need a second hop to the peer on every message. The object does not store ciphertext and does not add D1 tables. After it accepts a frame it calls the existing `POST /conversations/:id/messages` logic. The client also posts through `createMessagingClient`, and a repeated `clientId` returns the original row.

`wrangler dev` serves HTTP and WebSocket on the same port. Apply the D1 migrations first (the command above). The upgrade requires the same bearer session as `/me`, and the caller must already be a member — create the conversation with `POST /conversations` before connecting.

```bash
BASE=http://127.0.0.1:8787

# Unauthenticated upgrade is rejected. No socket is opened.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'connection: upgrade' \
  -H 'upgrade: websocket' \
  -H 'sec-websocket-version: 13' \
  -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE/realtime?conversationId=55555555-5555-4555-8555-555555555555"
```

That prints `401`. A member connects at `ws://127.0.0.1:8787/realtime?conversationId=<id>` with `Authorization: Bearer <sessionToken>`. The Expo client sets that header on the React Native WebSocket. Frames are JSON text:

| Direction | Frame |
| --- | --- |
| client → server | `{ "type": "subscribe", "conversationId" }` |
| client → server | `{ "type": "message", "conversationId", "ciphertext", "contentType?", "clientId?", "senderDeviceId?", "expireAt?" }` |
| server → client | `{ "type": "ready", "userId" }` then `{ "type": "subscribed", "conversationId" }` |
| server → client | `{ "type": "ack", "conversationId", "clientId" }` to the sender |
| server → client | `{ "type": "message", ...ciphertext, "fromUserId" }` to every other subscribed socket |
| server → client | `{ "type": "error", "error", "clientId?" }` |

`ciphertext` is an opaque base64 string (the Signal envelope, not plaintext). Field names `plaintext`, `plain_text`, `text`, `body`, `message`, `content`, and anything matching `/private/i` are rejected and are not forwarded or stored. One socket is one conversation. A second chat opens a second socket. Each conversation object allows 32 sockets, 8 of them from one user. A user can hold 16 sockets across conversations. A further upgrade is 429 with `Retry-After` and no socket.

An attachment uses that same frame. `contentType` is `attachment/v1` and `ciphertext` is still the Signal envelope (object key, mime, size, and the content key). The Durable Object does not fetch R2.

## Attachments (R2)

Binding `ATTACHMENTS`, bucket `encrypt-so-attachments`. `wrangler dev` simulates R2 locally under `.wrangler/state`. Create the remote bucket before `wrangler deploy`:

```bash
npx wrangler r2 bucket create encrypt-so-attachments
```

Members mint a short-lived upload grant, PUT opaque bytes, then send the Signal envelope through `/messages` or the WebSocket. The worker stores the blob as `application/octet-stream` and does not keep a filename. `$ALICE_TOKEN`, `$BOB_TOKEN`, and `$CONVO_ID` come from the session example above.

```bash
BASE=http://127.0.0.1:8787

GRANT=$(curl -s -X POST "$BASE/conversations/$CONVO_ID/attachments" \
  -H "authorization: Bearer $ALICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{}')
OBJECT=$(echo "$GRANT" | jq -r .objectKey)
UPLOAD=$(echo "$GRANT" | jq -r .uploadUrl)

# Ciphertext only. JSON, text, and multipart bodies are rejected.
curl -s -X PUT "$UPLOAD" \
  -H 'content-type: application/octet-stream' \
  --data-binary @ciphertext.bin

curl -s -o blob.bin "$BASE/conversations/$CONVO_ID/attachments/$OBJECT" \
  -H "authorization: Bearer $BOB_TOKEN"
```

`POST` with a field named `plaintext`, `filename`, `name`, `text`, `body`, `message`, `content`, or anything matching `/private/i` returns 400 and writes nothing. `expireAt` is the only other accepted field: the same disappearing deadline the client puts on the message. A non-member gets the same 404 as a missing conversation. The upload grant is single-use and expires in 120 seconds. The R2 object is tracked in `attachment_objects` and deleted at that `expireAt` or at the server ceiling, whichever is sooner.

## Push (metadata only)

`POST /push/register` stores an Expo push token for the signed-in user. `deviceId` is optional and, when present, must be a device that user owns. Repeating register for the same token updates the row.

When `POST /conversations/:id/messages` or the conversation Durable Object inserts a new row, the worker notifies every other member's tokens. The Expo payload is only:

- `title` / `body`: `New message`
- `data`: `{ conversationId, unread: true }`

The stored ciphertext is not loaded for that send. A retried `clientId` (`created: false`) does not send another push.

Delivery needs the Worker secret `EXPO_ACCESS_TOKEN` (`npx wrangler secret put EXPO_ACCESS_TOKEN`). If it is unset, the worker logs `push stub count=… reason=missing EXPO_ACCESS_TOKEN` and does not call `https://exp.host/--/api/v2/push/send`. Apply migration `0003_push_tokens.sql` before register or notify.

```bash
curl -s -X POST "$BASE/push/register" \
  -H "authorization: Bearer $ALICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"expoPushToken":"ExponentPushToken[alice-device]","platform":"ios"}'
```

## Guardrails

Limits are fixed windows in the `SESSIONS` KV namespace. A full window returns **429** with `Retry-After` (seconds) and `{ "error", "retryAfter" }`. The worker does not log ciphertext, attachment bytes, or phone numbers. The SMS stub still logs the constant code `000000`.

KV counters can admit a few extra requests under concurrency. `0` on a `RATE_*` value turns that limiter off. `MESSAGE_TTL_MS=0` turns off the server ceiling and leaves disappearing `expire_at` as the only deadline. `MAX_WS_*` of `0` accepts no new sockets.

| Variable | Default | Applies to |
| --- | --- | --- |
| `RATE_AUTH_START_PER_PHONE` | 8 | `POST /auth/phone/start` per phone |
| `RATE_AUTH_START_PER_IP` | 30 | start, per `CF-Connecting-IP` |
| `RATE_AUTH_START_WINDOW_SEC` | 600 | start window |
| `RATE_AUTH_VERIFY_PER_IP` | 40 | `POST /auth/phone/verify` per IP |
| `RATE_AUTH_VERIFY_WINDOW_SEC` | 600 | verify window |
| `AUTH_FAIL_BACKOFF_BASE_MS` | 1000 | wait after a rejected code; doubles each failure |
| `AUTH_FAIL_BACKOFF_MAX_MS` | 900000 | cap on that wait |
| `RATE_MESSAGE_PER_USER` | 60 | new ciphertext rows per user (HTTP and WebSocket) |
| `RATE_MESSAGE_PER_IP` | 120 | same, per IP |
| `RATE_MESSAGE_WINDOW_SEC` | 60 | message window |
| `RATE_PUSH_PER_USER` | 10 | `POST /push/register` and `/push/unregister` |
| `RATE_PUSH_PER_IP` | 20 | push, per IP |
| `RATE_PUSH_WINDOW_SEC` | 60 | push window |
| `RATE_ATTACHMENT_PER_USER` | 30 | upload grant and byte PUT, per user |
| `RATE_ATTACHMENT_PER_IP` | 60 | attachments, per IP |
| `RATE_ATTACHMENT_WINDOW_SEC` | 60 | attachment window |
| `MAX_BODY_BYTES` | 65536 | JSON bodies (`413`) |
| `MAX_CIPHERTEXT_CHARS` | 49152 | Signal envelope string (`413` `envelope too large`) |
| `MAX_ATTACHMENT_BYTES` | 26214400 | R2 ciphertext bytes |
| `MAX_WS_PER_CONVERSATION` | 32 | open sockets in one conversation object |
| `MAX_WS_PER_USER` | 8 | open sockets for one user in that object |
| `MAX_WS_PER_USER_GLOBAL` | 16 | open sockets for one user across conversations |
| `MESSAGE_TTL_MS` | 2592000000 | server ceiling (30 days), from `created_at` |
| `BLOCKLIST_PHONES` | empty | comma-separated E.164 numbers, rejected with 403 |
| `BLOCKLIST_IPS` | empty | comma-separated IPs, rejected with 403 |

A full socket cap returns 429 `too many connections` and does not complete the WebSocket upgrade. `clientId` replays are not counted against the message limit.

Disappearing messages stay on `expire_at`. The server ceiling does not replace that field. A row is hidden and deleted when either deadline has passed. Attachment blobs use `min(expireAt, now + MESSAGE_TTL_MS)` when the grant included `expireAt`, otherwise the ceiling alone. A cron (`*/15 * * * *`) runs the same delete. Listing or sending in a conversation also purges that conversation.

Blocklist hooks, any non-empty value except `0`:

- `block:ip:<ip>`
- `block:phone:<+E.164>`
- `block:user:<userId>`

Set them with `wrangler kv key put`. Delete the key to unblock. Blocked requests get 403 `forbidden`.

Override these in `wrangler.toml` `[vars]` or `workers/.dev.vars`. They are not secrets. `EXPO_ACCESS_TOKEN` stays a Worker secret and is not listed here.

## Routes

| Method | Path | Auth | Body → result |
| --- | --- | --- | --- |
| POST | `/auth/phone/start` | no | `{ phone }` → `{ challengeId }` |
| POST | `/auth/phone/verify` | no | `{ challengeId, code }` → `{ sessionToken, userId }` |
| GET | `/me` | Bearer | user + devices |
| POST | `/devices` | Bearer | `{ name }` → device |
| PUT | `/devices/:id/prekey-bundle` | Bearer | public bundle only |
| GET | `/users/:userId/prekey-bundle` | Bearer | public bundles; consumes one OTPK per device |
| POST | `/conversations` | Bearer | `{ peerUserId }` → 1:1 conversation (idempotent) |
| GET | `/conversations` | Bearer | conversations the caller belongs to |
| POST | `/conversations/:id/messages` | Bearer | `{ ciphertext, contentType?, clientId?, senderDeviceId?, expireAt? }` → stored ciphertext |
| GET | `/conversations/:id/messages` | Bearer | `?cursor=&limit=` oldest-first page; `nextCursor` is a message id |
| POST | `/conversations/:id/attachments` | Bearer | `{}` → `{ objectKey, uploadUrl, expiresAt }` |
| PUT | `/attachments/:objectKey?grant=` | upload grant | `application/octet-stream` ciphertext, max 25 MiB |
| GET | `/conversations/:id/attachments/:objectKey` | Bearer member | opaque ciphertext bytes |
| GET | `/realtime?conversationId=` | Bearer | WebSocket upgrade. Subscribe, then opaque `{ type: "message" }` frames |
| POST | `/push/register` | Bearer | `{ expoPushToken, platform, deviceId? }` → `{ registered: true }` |
| POST | `/push/unregister` | Bearer | `{ expoPushToken }` → `{ unregistered: true }` |

Sessions live in KV for 30 days. Challenges live for 10 minutes. A phone number can start 8 challenges per 10 minutes. An IP can start 30. A rejected verify code backs off before the next attempt. See [Guardrails](#guardrails).
