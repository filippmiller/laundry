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

/**
 * embedded-postgres rejects with `undefined` when the spawned cluster dies before it is ready
 * (its own `start()` rejects without an argument). A thrown `undefined` reaches the console as
 * the word "undefined", which hides the only clue about what went wrong.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error) return error;
  if (error === undefined) return "the cluster process ended without reporting an error";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    // The deadline must keep the event loop alive. An unref'd timer cannot: when the work never
    // settles (a cluster that crash-loops on a blocked port never prints "ready to accept
    // connections" and never exits), Node finds nothing left to wait for and exits with code 0.
    // The test run then looks green while not a single test file was executed. Keeping the timer
    // referenced makes the deadline fire, the setup fail, and `npm test` exit non-zero.
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
  // The whole boot is bounded, not just `start()`: `initialise()` runs initdb and rehydrates the
  // symlinks of a data directory that a killed run may have left in a broken state, and either of
  // those steps can hang without ever settling. An unbounded hang empties the event loop, Node
  // exits with code 0 and the suite reports success without having run a single test file.
  await withTimeout((async () => {
    if (fresh) await server!.initialise();
    await server!.start();
    try {
      await server!.createDatabase("laundry_test");
    } catch (error) {
      if (!String(error).includes("already exists")) throw error;
    }
  })(), 60_000, "embedded postgres did not come up within 60s").catch((error: unknown) => {
    throw new Error(`embedded postgres could not start on port 55433: ${describeError(error)}`);
  });
}

/**
 * A run that never finished its setup must not look successful.
 *
 * The setup runs in the vitest main process. If a step hangs in a way that leaves the event loop
 * empty, Node exits quietly with code 0 and the suite prints nothing — a green CI run that
 * tested nothing. This guard turns that silent exit into a failure no matter where the hang is.
 */
let setupFinished = false;
process.once("exit", (code) => {
  if (!setupFinished && code === 0) process.exitCode = 1;
});

export async function setup() {
  if (!(await reachable())) {
    const dataDir = ".pgdata-test";
    try {
      await boot(dataDir, false);
    } catch (error) {
      console.error(`embedded postgres failed to start, retrying with a fresh data directory: ${describeError(error)}`);
      await server?.stop().catch(() => undefined);
      try {
        await boot(dataDir, true);
      } catch (retryError) {
        // Never let the suite continue on a database that never came up: the tests would report
        // nothing and the run would look successful.
        throw new Error(`embedded postgres is unavailable: ${describeError(retryError)}`);
      }
    }
  }
  await runMigrations(url, "./drizzle");
  await resetTestData(url);
  setupFinished = true;
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
