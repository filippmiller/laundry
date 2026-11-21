import { defineConfig } from "vitest/config";

// The URL the suite runs against. A CI job (or any external PostgreSQL) provides it through
// the environment; the default is the embedded cluster that `test/global-setup.ts` boots.
// This used to be hardcoded, and because `test.env` injects it into every worker it
// overrode the CI environment — the suite then tried to reach the embedded port on a
// machine where it does not exist.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres_test_only@127.0.0.1:55433/laundry_test";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: { TEST_DATABASE_URL },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
