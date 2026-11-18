/**
 * Verify that the test suite honours an externally provided TEST_DATABASE_URL.
 *
 *   node scripts/verify-external-test-db.mjs
 *
 * This reproduces the CI condition: a PostgreSQL that is NOT the embedded cluster and NOT
 * on the default port. It used to fail — `vitest.config.ts` pinned the URL and injected it
 * into every worker, so the suite always tried to reach the embedded port.
 */
import EmbeddedPostgres from "embedded-postgres";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 55437;
const DATA_DIR = ".pgdata-verify";
const DB_URL = `postgres://postgres:postgres_verify_only@127.0.0.1:${PORT}/laundry_verify`;

rmSync(DATA_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres_verify_only",
  port: PORT,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => undefined,
  onError: () => undefined,
});

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("laundry_verify");
  await run("npm", ["run", "db:migrate"], { DATABASE_URL: DB_URL });
  console.log(`\nRunning the suite against the external database ${DB_URL}`);
  await run("npx", ["vitest", "run"], { TEST_DATABASE_URL: DB_URL });
  console.log("EXTERNAL_DATABASE_SUITE_OK");
} catch (error) {
  console.error("verification failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pg.stop().catch(() => undefined);
  rmSync(DATA_DIR, { recursive: true, force: true });
}
