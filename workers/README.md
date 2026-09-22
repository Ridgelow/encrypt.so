# encrypt.so API

Cloudflare Worker for auth, public identity, ciphertext persistence, encrypted attachment blobs, and realtime delivery of opaque envelopes. SMS is stubbed: every challenge accepts code `000000`. No private keys and no plaintext messages are stored.

## Bindings

| Binding | Type | Name | Used for |
| --- | --- | --- | --- |
| `DB` | D1 | `encrypt-so` | users, devices, public prekey bundles, conversations, memberships, ciphertext |
| `SESSIONS` | KV | (namespace you create) | phone challenges, session tokens, start rate limits |
| `CONVERSATIONS` | Durable Object | `ConversationRoom` | one object per 1:1 conversation; live WebSocket fan-out |
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

A body field named `plaintext`, `text`, `body`, `message`, or `content` is rejected with 400. `clientId` retries return the original row. `senderDeviceId` is required only when the sender has more than one device. `expireAt` (unix milliseconds) hides the row from later lists.

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

`ciphertext` is an opaque base64 string (the Signal envelope, not plaintext). Field names `plaintext`, `plain_text`, `text`, `body`, `message`, `content`, and anything matching `/private/i` are rejected and are not forwarded or stored. One socket is one conversation. A second chat opens a second socket.

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

`POST` with a field named `plaintext`, `filename`, `name`, `text`, `body`, `message`, `content`, or anything matching `/private/i` returns 400 and writes nothing. A non-member gets the same 404 as a missing conversation. The upload grant is single-use and expires in 120 seconds.

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

Sessions live in KV for 30 days. Challenges live for 10 minutes. A phone number can start 8 challenges per 10 minutes.
