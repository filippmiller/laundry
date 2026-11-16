import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres_test_only@127.0.0.1:55432/laundry_test";
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

export async function setup() {
  if (!(await reachable())) {
    const dataDir = ".pgdata-test";
    if (existsSync(dataDir) && !existsSync(resolve(dataDir, "PG_VERSION"))) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    const fresh = !existsSync(resolve(dataDir, "PG_VERSION"));
    server = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "postgres_test_only",
      port: 55432,
      persistent: true,
      autoRehydrateSymlinks: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => undefined,
    });
    if (fresh) await server.initialise();
    await server.start();
    try {
      await server.createDatabase("laundry_test");
    } catch (error) {
      if (!String(error).includes("already exists")) throw error;
    }
  }
  await runMigrations(url, "./drizzle");
}

export async function teardown() {
  await server?.stop();
}
