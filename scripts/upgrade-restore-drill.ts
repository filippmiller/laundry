/**
 * Populated-database upgrade/restore drill. Proves, on a throwaway cluster:
 *  1. the full migration chain (0000..current) applies to an empty database;
 *  2. the demo seed populates it and one worker cycle runs against real data;
 *  3. re-running migrations on the populated database is a no-op (upgrade path is idempotent);
 *  4. a physical clone (CREATE DATABASE ... TEMPLATE) preserves every row exactly — the restore path.
 * The cluster lives under .pgdata-drill and is deleted when the drill ends.
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { seedDemo } from "../src/services/seed.js";
import { runOnce } from "../src/workers/index.js";

const PORT = 55434;
const DATA_DIR = ".pgdata-drill";
const DB = "laundry_drill";
const CLONE = "laundry_drill_restored";
const url = `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/${DB}`;
const adminUrl = `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/postgres`;

// Tables whose population and exact preservation both matter.
const CHECKED_TABLES = [
  "organizations", "users", "memberships", "service_windows", "orders", "order_lines",
  "quotes", "outbox_events", "audit_events", "notifications", "payment_intents",
  "custody_events", "garments", "ledger_journals", "ledger_entries",
];

async function counts(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  const result: Record<string, number> = {};
  try {
    for (const table of CHECKED_TABLES) {
      const res = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      result[table] = res.rows[0].count;
    }
  } finally {
    await client.end();
  }
  return result;
}

async function main() {
  if (existsSync(DATA_DIR) && !existsSync(resolve(DATA_DIR, "PG_VERSION"))) {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
  const fresh = !existsSync(resolve(DATA_DIR, "PG_VERSION"));
  if (!fresh) rmSync(DATA_DIR, { recursive: true, force: true });
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres_drill_only",
    port: PORT,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: message => console.error(String(message)),
  });
  await server.initialise();
  await server.start();
  let failed = false;
  try {
    await server.createDatabase(DB);

    // 1. Empty database -> full migration chain.
    await runMigrations(url, "./drizzle");
    console.log("drill: migration chain applied");

    // 2. Populate with the demo seed plus a real scheduled order (quotes, ledger, outbox, audit),
    // then run one worker cycle against it.
    const { createDb } = await import("../src/db/client.js");
    const { seedFullOrder } = await import("../test/operations-fixtures.js");
    const seeded = createDb(url, { max: 4 });
    try {
      await seedDemo(seeded.db);
      await seedFullOrder(seeded.db, { state: "scheduled" });
    } finally {
      await seeded.pool.end();
    }
    const workerSummary = await runOnce(url);
    console.log("drill: seed + worker cycle done", JSON.stringify(workerSummary));
    if (workerSummary.outboxProcessed < 2) {
      throw new Error(`drill: worker drained too few outbox events: ${JSON.stringify(workerSummary)}`);
    }
    const before = await counts(url);
    for (const table of ["orders", "quotes", "outbox_events", "audit_events"]) {
      if ((before[table] ?? 0) < 1) throw new Error(`drill: ${table} not populated`);
    }

    // 3. Upgrade path: migrations re-run on a populated database change nothing.
    await runMigrations(url, "./drizzle");
    const afterUpgrade = await counts(url);
    for (const [table, count] of Object.entries(before)) {
      if (afterUpgrade[table] !== count) throw new Error(`drill: upgrade changed ${table}`);
    }
    console.log("drill: re-migration is a no-op on populated data");

    // 4. Restore path: physical clone preserves every row.
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${CLONE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${CLONE} TEMPLATE ${DB}`);
    } finally {
      await admin.end();
    }
    const restored = await counts(`postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/${CLONE}`);
    for (const [table, count] of Object.entries(before)) {
      if (restored[table] !== count) {
        throw new Error(`drill: restore lost rows in ${table}: ${count} -> ${restored[table]}`);
      }
    }
    console.log("drill: physical clone preserves all rows:", JSON.stringify(before));
    console.log("DRILL PASSED");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await server.stop().catch(() => undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(DATA_DIR, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(resolveTimer => setTimeout(resolveTimer, 1_000));
      }
    }
    if (failed) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("drill failed:", error);
  process.exitCode = 1;
});
