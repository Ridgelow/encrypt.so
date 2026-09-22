// Optional Worker secret. Set with `npx wrangler secret put EXPO_ACCESS_TOKEN`.
// When it is absent, push delivery is logged and not sent.
interface Env {
  EXPO_ACCESS_TOKEN?: string;
}
