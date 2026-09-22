# Project Context — E2EE Messaging App

Reference doc for the stack, architecture, and brand decisions made so far. Keep this at the repo root so it is available as context in Cursor.

## What this is

**encrypt.so** — a mobile, end-to-end encrypted messaging app, styled with the BLACKOUT brand kit (Watch Dogs–inspired: black/white/grey ladder, no accent color, Hacked wordmark font, hand-drawn HR mark).

### Naming

| Context | Form |
| --- | --- |
| Product / domain / marketing | `encrypt.so` |
| Mobile app wordmark / home screen label | `encrypt_` |

Use `encrypt_` (trailing underscore) in the native UI chrome — splash, nav wordmark, app icon label where space allows. Use `encrypt.so` for the domain, deep links, and any web/Pages surface.

## Stack

### Client

- **React Native + Expo**, TypeScript
- **NativeWind** (Tailwind for RN) — BLACKOUT’s `tailwind.config.ts` colors (the `bo-` grey ladder) port over directly
- **Fonts via `expo-font`:** Hacked (`.ttf`), Saira Condensed, Barlow, Pixel Operator Mono (`.ttf` converted from the brand kit `.woff2`)
- **Motion:** `react-native-reanimated` + `react-native-svg` for the kit’s signature effects (GlitchTitle tears, StaticBurst debris, ScanPanel sweeps) — port the `steps()`-based timings from `motion.md` to Reanimated `easing` / `withTiming`
- **Key storage:** `expo-secure-store` (iOS Keychain / Android Keystore) — private keys never touch AsyncStorage

### Encryption — Signal Protocol

- **X3DH** for initial key agreement, **Double Ratchet** for per-message forward secrecy
- **Library:** `@open-e2ee/signal-protocol-sdk` (maintained pure-TypeScript X3DH / PQXDH + Double Ratchet on `@noble/*`). Do not hand-roll the ratchet. Private keys and 1:1 session records live in `expo-secure-store`. The Auth worker stores the public bundle only (`PUT /devices/:id/prekey-bundle`). `GET /users/:userId/prekey-bundle` is what the client uses to start a session. The worker does not publish the ML-KEM prekey, so those sessions use the SDK's classical X3DH path. The SDK's SQLCipher Expo store is not used, so this runs in Expo Go. A development build is required only if a later change adopts that SQLCipher store.
- **1:1 sessions are client-side only.** `src/e2ee` establishes a session and encrypts or decrypts an opaque envelope. A conversation Durable Object fans that ciphertext out over WebSockets. Disappearing-message timers stay on the client and are copied onto `expireAt` at send. Group messaging is still a separate decision.
- Server sees and stores **ciphertext and minimal metadata only** — treat message body as opaque bytes in the schema from day one, not something to encrypt later
- **Group messaging** is a separate, harder problem (Signal Sender Keys vs. MLS/OpenMLS) — not yet decided; see [Open decisions](#open-decisions)

### Backend — Cloudflare

- **Cloudflare Workers + Durable Objects**, native WebSocket API for realtime — not Socket.IO, which needs a persistent Node process and does not run properly on the Workers runtime. A Durable Object per conversation (or per user) is the natural fit for connection state.
- **Push:** Expo push tokens live in D1 (`push_tokens`). A new message notifies other members with metadata only: generic title `New message`, `conversationId`, and `unread: true`. No plaintext and no ciphertext in the payload. Missing `EXPO_ACCESS_TOKEN` stubs delivery.
- **D1** (SQLite) for metadata/session data; move to Postgres via Hyperdrive if relational needs outgrow D1
- **R2** for encrypted attachments/file blobs — server never has plaintext. Binding `ATTACHMENTS` stores AES-GCM ciphertext only. The Signal envelope (`attachment/v1`) wraps the content key and is sent on the existing message and WebSocket path.
- **KV** for session tokens / rate limiting
- Worker source: `workers/` (auth, public prekey bundles, ciphertext routes, R2 attachment blobs, and a Durable Object per 1:1 conversation for realtime). See `workers/README.md`.
- Any marketing or web landing page → **Cloudflare Pages**

## Brand kit — BLACKOUT

Source: `/Users/hasnainrizvi/Downloads/BLACKOUT-brand-kit` (also exported as `BLACKOUT-brand-kit.zip`).

- **Palette:** 11-step black→white grey ladder (`black` → `coal` → `ash` → `graphite` → `iron` → `rule` → `steel` → `ghost` → `smoke` → `chalk` → `white`), zero accent color. Emphasis comes from inversion or a hairline `edge-live` ring, never a hue.
- **Type:**
  - Hacked — wordmark only, 28px+ floor
  - Saira Condensed — section/card titles (the only text allowed to glitch)
  - Barlow — body/labels
  - Pixel Operator Mono — anything machine-generated: IDs, timestamps, message metadata
- **Motion verbs:** draw / snap / burst / sweep / tick — hard `steps()` timing throughout, no fades, no ease-in-out
- **Logo:** hand-drawn HR monogram, white-on-dark and black-on-light variants, 56px minimum size
- Full kit (tokens, components, fonts, logo files): see the brand kit export above

### Color ladder (quick reference)

| Token     | Hex       | Role                          |
| --------- | --------- | ----------------------------- |
| black     | `#000000` | Page ground                   |
| coal      | `#060608` | Near-black panel              |
| ash       | `#0e0e10` | Standard panel / HUD fill     |
| graphite  | `#16161a` | Nested panel                  |
| iron      | `#1f1f24` | Inputs / buttons at rest      |
| rule      | `#2e2e34` | Borders only (never text)     |
| steel     | `#4a4a52` | Disabled / debris             |
| ghost     | `#6b6b73` | Decorative marks              |
| smoke     | `#9a9aa2` | Secondary text                |
| chalk     | `#c9c9cf` | Body text                     |
| white     | `#ffffff` | Headlines / focus only        |

## Open decisions

- **Group chat:** Signal Sender Keys vs. MLS (OpenMLS) — revisit once group messaging is actually in scope
- Whether any part of the stack needs a **fallback off Workers** (Durable Objects have connection/CPU-time limits worth checking against expected message volume)
