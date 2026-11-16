import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL = "postgres://postgres:postgres_test_only@127.0.0.1:55432/laundry_test";

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
