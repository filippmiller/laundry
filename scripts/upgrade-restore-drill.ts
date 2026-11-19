/**
 * Populated-database upgrade/restore drill. Proves:
 *  1. the full migration chain (0000..current) applies to an empty database;
 *  2. the demo seed populates it (including orders, ledger_entries, evidence_assets, users)
 *     and one worker cycle runs against real data;
 *  3. re-running migrations on the populated database is a no-op (upgrade path is idempotent);
 *  4. a real `pg_dump -Fc` -> `pg_restore` into a separate fresh database (or `RESTORE_DATABASE_URL`
 *     for off-instance restore) preserves every row count and key table checksums.
 *
 * Set `DRILL_DATABASE_URL` (or `TEST_DATABASE_URL`) to run against an external PostgreSQL 16
 * server (e.g. CI service container). Otherwise boots a throwaway embedded-postgres cluster.
 * Set `DRILL_REQUIRE_PG_DUMP=true` (used in CI) to forbid falling back to `CREATE DATABASE TEMPLATE`.
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";
import { seedDemo } from "../src/services/seed.js";
import { runOnce } from "../src/workers/index.js";

const PORT = 55434;
const DATA_DIR = ".pgdata-drill";
const SRC_DB = "laundry_drill_src";
const RESTORED_DB = "laundry_drill_restored";

// Tables whose population and exact preservation both matter.
const CHECKED_TABLES = [
  "organizations", "users", "memberships", "service_windows", "orders", "order_lines",
  "quotes", "outbox_events", "audit_events", "notifications", "payment_intents",
  "custody_events", "garments", "ledger_journals", "ledger_entries", "evidence_assets",
];

// Key tables verified with content checksums on top of row counts.
const CHECKSUM_QUERIES: Record<string, string> = {
  orders: "SELECT id, public_number, lifecycle_state FROM orders ORDER BY id",
  ledger_entries: "SELECT id, journal_id, account_id, debit_kopeks, credit_kopeks FROM ledger_entries ORDER BY id",
  evidence_assets: "SELECT id, owner_type, owner_id, sha256, status, legal_hold_count FROM evidence_assets ORDER BY id",
  users: "SELECT id, phone, display_name FROM users ORDER BY id",
};

function replaceDbInUrl(connectionString: string, dbName: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function findPgBinary(name: "pg_dump" | "pg_restore"): string | null {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return name;
  } catch {
    return null;
  }
}

async function countsAndChecksums(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  const counts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  try {
    for (const table of CHECKED_TABLES) {
      const res = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      counts[table] = res.rows[0].count;
    }
    for (const [table, query] of Object.entries(CHECKSUM_QUERIES)) {
      const res = await client.query(query);
      const hash = createHash("sha256").update(JSON.stringify(res.rows)).digest("hex");
      checksums[table] = hash;
    }
  } finally {
    await client.end();
  }
  return { counts, checksums };
}

async function main() {
  const externalBaseUrl = process.env.DRILL_DATABASE_URL?.trim();
  const explicitRestoreUrl = process.env.RESTORE_DATABASE_URL?.trim();
  const requirePgDump = process.env.DRILL_REQUIRE_PG_DUMP === "true";

  const pgDumpBin = findPgBinary("pg_dump");
  const pgRestoreBin = findPgBinary("pg_restore");
  const hasPgDumpRestore = Boolean(pgDumpBin && pgRestoreBin);
  if (requirePgDump && !hasPgDumpRestore) {
    throw new Error("drill: DRILL_REQUIRE_PG_DUMP=true but pg_dump/pg_restore binaries are not available on PATH");
  }

  let server: EmbeddedPostgres | undefined;
  let adminUrl: string;
  let sourceUrl: string;
  let restoredUrl: string;
  const dumpFile = join(tmpdir(), `laundry-drill-${Date.now()}.dump`);

  if (externalBaseUrl) {
    adminUrl = replaceDbInUrl(externalBaseUrl, "postgres");
    sourceUrl = replaceDbInUrl(externalBaseUrl, SRC_DB);
    restoredUrl = explicitRestoreUrl ?? replaceDbInUrl(externalBaseUrl, RESTORED_DB);
  } else {
    if (existsSync(DATA_DIR) && !existsSync(resolve(DATA_DIR, "PG_VERSION"))) {
      rmSync(DATA_DIR, { recursive: true, force: true });
    }
    const fresh = !existsSync(resolve(DATA_DIR, "PG_VERSION"));
    if (!fresh) rmSync(DATA_DIR, { recursive: true, force: true });
    server = new EmbeddedPostgres({
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
    adminUrl = `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/postgres`;
    sourceUrl = `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/${SRC_DB}`;
    restoredUrl = explicitRestoreUrl ?? `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/${RESTORED_DB}`;
  }

  let failed = false;
  try {
    // Prepare fresh source database.
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${SRC_DB}`);
    } finally {
      await admin.end();
    }

    // 1. Empty database -> full migration chain.
    await runMigrations(sourceUrl, "./drizzle");
    console.log("drill: migration chain applied");

    // 2. Populate with demo seed + scheduled order + evidence + captured payment/ledger,
    //    then run one worker cycle against it.
    const { createDb } = await import("../src/db/client.js");
    const { seedFullOrder } = await import("../test/operations-fixtures.js");
    const { registerEvidence } = await import("../src/services/workspace.js");
    const { createCustomerInvoice, capturePayment } = await import("../src/services/finance.js");
    const { makePrincipal } = await import("../test/fixtures.js");
    const seeded = createDb(sourceUrl, { max: 4 });
    try {
      await seedDemo(seeded.db);
      const order = await seedFullOrder(seeded.db, { state: "scheduled" });
      await registerEvidence(seeded.db, order.principal, {
        ownerType: "order",
        ownerId: order.orderId,
        objectKey: `drill/${order.orderId}.jpg`,
        sha256: "a".repeat(64),
        purpose: "intake_condition",
        key: `drill-ev-${order.orderId}`,
      });
      const finance = makePrincipal(order.organizationId, order.userId, ["platform_finance"]);
      const invoice = await createCustomerInvoice(seeded.db, finance, {
        orderId: order.orderId,
        key: `drill-inv-${order.orderId}`,
      });
      await capturePayment(seeded.db, finance, {
        orderId: order.orderId,
        amountKopeks: invoice.totalKopeks,
        key: `drill-cap-${order.orderId}`,
      });
    } finally {
      await seeded.pool.end();
    }

    const workerSummary = await runOnce(sourceUrl);
    console.log("drill: seed + worker cycle done", JSON.stringify(workerSummary));
    if (workerSummary.outboxProcessed < 2) {
      throw new Error(`drill: worker drained too few outbox events: ${JSON.stringify(workerSummary)}`);
    }
    const before = await countsAndChecksums(sourceUrl);
    for (const table of ["orders", "quotes", "outbox_events", "audit_events", "ledger_entries", "evidence_assets", "users"]) {
      if ((before.counts[table] ?? 0) < 1) throw new Error(`drill: ${table} not populated`);
    }

    // 3. Upgrade path: migrations re-run on a populated database change nothing.
    await runMigrations(sourceUrl, "./drizzle");
    const afterUpgrade = await countsAndChecksums(sourceUrl);
    for (const [table, count] of Object.entries(before.counts)) {
      if (afterUpgrade.counts[table] !== count) throw new Error(`drill: upgrade changed ${table}`);
    }
    console.log("drill: re-migration is a no-op on populated data");

    // 4. Restore path: real pg_dump -Fc -> pg_restore into a separate fresh database/instance.
    if (hasPgDumpRestore) {
      execFileSync(pgDumpBin!, ["-Fc", "--no-owner", "--no-privileges", "-f", dumpFile, sourceUrl], {
        stdio: "pipe",
      });
      if (!explicitRestoreUrl) {
        const restoreAdmin = new Client({ connectionString: adminUrl });
        await restoreAdmin.connect();
        try {
          await restoreAdmin.query(`DROP DATABASE IF EXISTS ${RESTORED_DB} WITH (FORCE)`);
          await restoreAdmin.query(`CREATE DATABASE ${RESTORED_DB}`);
        } finally {
          await restoreAdmin.end();
        }
      }
      execFileSync(pgRestoreBin!, ["--no-owner", "--no-privileges", "-d", restoredUrl, dumpFile], {
        stdio: "pipe",
      });
      console.log("drill: pg_dump -Fc -> pg_restore completed into fresh target database");
    } else {
      console.warn("drill: pg_dump/pg_restore not on PATH; falling back to local TEMPLATE clone (disallowed in CI)");
      const cloneAdmin = new Client({ connectionString: adminUrl });
      await cloneAdmin.connect();
      try {
        await cloneAdmin.query(`DROP DATABASE IF EXISTS ${RESTORED_DB} WITH (FORCE)`);
        await cloneAdmin.query(`CREATE DATABASE ${RESTORED_DB} TEMPLATE ${SRC_DB}`);
      } finally {
        await cloneAdmin.end();
      }
    }

    const restored = await countsAndChecksums(restoredUrl);
    for (const [table, count] of Object.entries(before.counts)) {
      if (restored.counts[table] !== count) {
        throw new Error(`drill: restore lost rows in ${table}: ${count} -> ${restored.counts[table]}`);
      }
    }
    for (const [table, hash] of Object.entries(before.checksums)) {
      if (restored.checksums[table] !== hash) {
        throw new Error(`drill: restore checksum mismatch in ${table}: ${hash} -> ${restored.checksums[table]}`);
      }
    }
    console.log("drill: restore verified exact row counts:", JSON.stringify(before.counts));
    console.log("drill: restore verified table checksums:", JSON.stringify(before.checksums));
    console.log("DRILL PASSED");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (existsSync(dumpFile)) {
      rmSync(dumpFile, { force: true });
    }
    if (externalBaseUrl) {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect().catch(() => undefined);
      await cleanup.query(`DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)`).catch(() => undefined);
      if (!explicitRestoreUrl) {
        await cleanup.query(`DROP DATABASE IF EXISTS ${RESTORED_DB} WITH (FORCE)`).catch(() => undefined);
      }
      await cleanup.end().catch(() => undefined);
    }
    if (server) {
      await server.stop().catch(() => undefined);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(DATA_DIR, { recursive: true, force: true });
          break;
        } catch {
          await new Promise(resolveTimer => setTimeout(resolveTimer, 1_000));
        }
      }
    }
    if (failed) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("drill failed:", error);
  process.exitCode = 1;
});
