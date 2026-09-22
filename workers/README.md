# encrypt.so API

Cloudflare Worker for auth and public identity. SMS is stubbed: every challenge accepts code `000000`. No private keys are stored.

## Bindings

| Binding | Type | Name | Used for |
| --- | --- | --- | --- |
| `DB` | D1 | `encrypt-so` | users, devices, public prekey bundles |
| `SESSIONS` | KV | (namespace you create) | phone challenges, session tokens, start rate limits |

`wrangler.toml` ships with placeholder IDs. Local `wrangler dev` ignores them and uses local D1/KV. Replace the IDs before `wrangler deploy`.

## First-time setup

```bash
cd workers
npm install
npx wrangler login
npx wrangler d1 create encrypt-so
npx wrangler kv namespace create SESSIONS
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

## Routes

| Method | Path | Auth | Body → result |
| --- | --- | --- | --- |
| POST | `/auth/phone/start` | no | `{ phone }` → `{ challengeId }` |
| POST | `/auth/phone/verify` | no | `{ challengeId, code }` → `{ sessionToken, userId }` |
| GET | `/me` | Bearer | user + devices |
| POST | `/devices` | Bearer | `{ name }` → device |
| PUT | `/devices/:id/prekey-bundle` | Bearer | public bundle only |
| GET | `/users/:userId/prekey-bundle` | Bearer | public bundles; consumes one OTPK per device |

Sessions live in KV for 30 days. Challenges live for 10 minutes. A phone number can start 8 challenges per 10 minutes.
