import fs from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The vitest pool's workerd build supports compatibility dates through 2026-08-22.
// Production wrangler.toml stays on its own date; tests run against a copy.
const root = import.meta.dirname;
const source = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const testConfigPath = path.join(root, "wrangler.vitest.toml");
fs.writeFileSync(
  testConfigPath,
  source.replace(/compatibility_date\s*=\s*"[^"]+"/, 'compatibility_date = "2026-08-22"'),
);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: testConfigPath },
        miniflare: {
          compatibilityDate: "2026-08-22",
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      isolate: false,
      fileParallelism: false,
      maxWorkers: 1,
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
