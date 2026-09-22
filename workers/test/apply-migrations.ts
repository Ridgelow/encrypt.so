import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const bound = env as typeof env & { TEST_MIGRATIONS?: D1Migration[] };
if (!bound.TEST_MIGRATIONS) throw new Error("TEST_MIGRATIONS binding is missing");
await applyD1Migrations(env.DB, bound.TEST_MIGRATIONS);
