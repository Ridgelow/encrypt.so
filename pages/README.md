# encrypt.so landing

Static marketing site for [Cloudflare Pages](https://developers.cloudflare.com/pages/). It does not share code with the Expo app or the API worker in `workers/`.

BLACKOUT tokens match `PROJECT.md` and `src/theme/tokens.ts`: the grey ladder, no accent color, Hacked for the `encrypt_` wordmark.

## Preview

From this directory:

```bash
python3 -m http.server 4173 --directory public
```

Then open http://127.0.0.1:4173

## Deploy

Wrangler 3.91 or newer reads `pages_build_output_dir` in `wrangler.toml`.

From the repo root:

```bash
npx wrangler login
npx wrangler pages deploy --cwd pages
```

Or from `pages/`:

```bash
npx wrangler pages deploy
```

The first deploy creates a Pages project named `encrypt-so` (https://encrypt-so.pages.dev). Attach the `encrypt.so` domain in the Cloudflare dashboard when the apex should serve this site.

This project has no bindings and no Pages Functions. `wrangler pages dev` serves `public/` locally:

```bash
npx wrangler pages dev --cwd pages
```

Use `wrangler pages deploy` here. `wrangler deploy` is for the API worker.
