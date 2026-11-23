/**
 * Safe inventory of a PostgreSQL data directory.
 *
 * Used to classify an exposed cluster (e.g. the `.pgdata-drill/` directory that was
 * committed to the public repository) as TEST_ONLY or NEEDS_INCIDENT_RESPONSE.
 *
 *   node scripts/inventory-pg-cluster.mjs <dataDir> [--port 55435]
 *
 * Safety rules, deliberately:
 *   - the script NEVER prints row contents, only counts and aggregate predicates;
 *   - phone numbers are only ever counted by pattern, never printed;
 *   - nothing is written to the cluster and the server is stopped again immediately.
 *
 * It answers one question: does this cluster hold real personal data, or only
 * synthetic demo/test data?
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = process.argv[2];
const portArgIndex = process.argv.indexOf("--port");
const PORT = portArgIndex === -1 ? 55435 : Number(process.argv[portArgIndex + 1]);

if (!dataDir || !existsSync(resolve(dataDir, "PG_VERSION"))) {
  console.error(`usage: node scripts/inventory-pg-cluster.mjs <dataDir> [--port <n>]`);
  console.error("the directory must be a PostgreSQL data directory (it must contain PG_VERSION)");
  process.exit(2);
}

/** Tables whose row counts characterise the cluster. */
const TABLES = [
  "organizations", "users", "memberships", "buildings", "service_windows", "quotes", "orders",
  "order_lines", "garments", "seals", "custody_events", "payment_intents", "ledger_journals",
  "ledger_entries", "outbox_events", "audit_events", "notifications", "customer_addresses",
  "evidence_assets", "support_threads",
];

async function inventory(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  const result = { tables: {}, organizations: [], users: { total: 0, demoPersona: 0, randomShape: 0 } };
  try {
    for (const table of TABLES) {
      const res = await client.query(
        `SELECT count(*)::int AS count FROM "${table}"`,
      ).catch(() => null);
      result.tables[table] = res ? res.rows[0].count : null;
    }
    // Organisation names are business names, not personal data, and they are the clearest
    // signal of what the cluster holds.
    const orgs = await client.query("SELECT name FROM organizations ORDER BY name").catch(() => null);
    result.organizations = orgs ? orgs.rows.map(row => row.name) : [];

    const total = await client.query("SELECT count(*)::int AS count FROM users");
    result.users.total = total.rows[0].count;
    if (result.users.total > 0) {
      const demo = await client.query(
        "SELECT count(*)::int AS count FROM users WHERE phone LIKE '+799900000%'",
      );
      result.users.demoPersona = demo.rows[0].count;
      // The remaining users were created by the test fixtures with `Math.random()` phone
      // numbers. Those have exactly the shape of a real Russian mobile number, so the shape
      // alone can never prove that a number is real — the provenance of the dataset does.
      result.users.randomShape = result.users.total - result.users.demoPersona;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return result;
}

/**
 * Classify the cluster.
 *
 * A cluster counts as NEEDS_INCIDENT_RESPONSE when it holds rows that could carry real
 * personal content — evidence/media, garments, payment intents, ledger entries or support
 * threads. A cluster that holds only the demo organisation, demo personas and synthetic
 * fixture rows is TEST_ONLY.
 */
function classify(report) {
  const personalTables = ["evidence_assets", "garments", "payment_intents", "ledger_journals", "ledger_entries", "support_threads"];
  const reasons = [];
  for (const database of report.databases) {
    for (const table of personalTables) {
      const count = database.tables[table];
      if (typeof count === "number" && count > 0) {
        reasons.push(`${database.name}.${table} has ${count} row(s)`);
      }
    }
    const unknownOrg = database.organizations.filter(name => !isDemoOrganisation(name));
    if (unknownOrg.length) {
      reasons.push(`${database.name} contains a non-demo organisation (${unknownOrg.length})`);
    }
  }
  return {
    classification: reasons.length ? "NEEDS_INCIDENT_RESPONSE" : "TEST_ONLY",
    reasons,
  };
}

/**
 * The organisations the demo seed and the test fixtures create: the demo tenant from
 * `src/services/seed.ts` and the randomly named `Org <random>` tenant from
 * `test/fixtures.ts`.
 */
function isDemoOrganisation(name) {
  return DEMO_ORGANISATION_NAMES.has(name) || /^Org [0-9a-z]{6,}$/i.test(name);
}

const DEMO_ORGANISATION_NAMES = new Set(["Демо-прачечная", "Демо", "Demo"]);

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres_drill_only",
  port: PORT,
  persistent: true,
  autoRehydrateSymlinks: true,
  onLog: message => console.error("[pg]", String(message).trim()),
  onError: message => console.error("[pg]", String(message).trim()),
});

try {
  await server.start();
  const admin = new Client({ connectionString: `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/postgres` });
  await admin.connect();
  const databases = await admin.query(
    "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
  );
  await admin.end().catch(() => undefined);

  const report = { data_dir: dataDir, databases: [] };
  for (const row of databases.rows) {
    const name = row.datname;
    if (["postgres", "template0", "template1"].includes(name)) continue;
    const url = `postgres://postgres:postgres_drill_only@127.0.0.1:${PORT}/${name}`;
    report.databases.push({ name, ...(await inventory(url)) });
  }

  console.log(JSON.stringify(report, null, 2));
  const verdict = classify(report);
  console.log(`CLASSIFICATION: ${verdict.classification}`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  console.log(
    verdict.classification === "TEST_ONLY"
      ? "No evidence, garment, payment, ledger or support rows, and only demo organisations: the cluster holds synthetic demo and test-fixture data only."
      : "The cluster holds rows that could carry real personal content — treat it as an incident until proven otherwise.",
  );
} catch (error) {
  console.error("inventory failed:", error instanceof Error ? error.message : JSON.stringify(error));
  if (error && typeof error === "object" && "cause" in error) {
    console.error("cause:", JSON.stringify(error.cause));
  }
  process.exitCode = 1;
} finally {
  await server.stop().catch(() => undefined);
}
