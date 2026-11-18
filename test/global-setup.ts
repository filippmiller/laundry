import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres_test_only@127.0.0.1:55433/laundry_test";
let server: EmbeddedPostgres | undefined;

async function reachable() {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1_500 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function boot(dataDir: string, reset: boolean) {
  if (reset) rmSync(dataDir, { recursive: true, force: true });
  if (existsSync(dataDir) && !existsSync(resolve(dataDir, "PG_VERSION"))) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  const fresh = !existsSync(resolve(dataDir, "PG_VERSION"));
  server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres_test_only",
    port: 55433,
    persistent: true,
    autoRehydrateSymlinks: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: message => {
      const text = String(message);
      if (!text.includes("ECONNRESET") && !text.includes("Connection terminated unexpectedly")) {
        console.error(text);
      }
    },
  });
  if (fresh) await server.initialise();
  // A data directory left behind by a killed run can hang forever: fail fast, then rebuild it.
  await withTimeout(server.start(), 45_000, "embedded postgres did not start within 45s");
  try {
    await server.createDatabase("laundry_test");
  } catch (error) {
    if (!String(error).includes("already exists")) throw error;
  }
}

export async function setup() {
  if (!(await reachable())) {
    const dataDir = ".pgdata-test";
    try {
      await boot(dataDir, false);
    } catch (error) {
      console.error("embedded postgres failed to start, retrying with a fresh data directory:", error);
      await server?.stop().catch(() => undefined);
      await boot(dataDir, true);
    }
  }
  await runMigrations(url, "./drizzle");
  await resetTestData(url);
}

/**
 * Empty every table of the `public` schema so that a test run always starts from the
 * same state.
 *
 * The cluster is persistent, so without this the suite depends on how many times it has
 * been run before: the `outbox_events` backlog grows with every run, `processOutbox`
 * claims only the oldest 500 pending events, and the newest events of a late-running test
 * file are never claimed — which made `npm test` fail on a repository that had simply been
 * tested a few times. The migrations keep their own bookkeeping in the `drizzle` schema
 * and are therefore left untouched.
 */
async function resetTestData(connectionString: string) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(`
      DO $reset$
      DECLARE
        target text;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
          INTO target
          FROM pg_tables
         WHERE schemaname = 'public';
        IF target IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || target || ' CASCADE';
        END IF;
      END
      $reset$;
    `);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function teardown() {
  await server?.stop();
}
