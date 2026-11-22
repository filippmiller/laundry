/**
 * Verifiable populated-DB migration upgrade proof: 0000..0025 -> seed pre-0026/0027 anomalies ->
 * apply 0026 + 0027 -> verify before/after transformations, idempotent re-run, and legacy-data audit.
 *
 * Distinct from `npm run db:drill` (which migrates an empty DB through the full chain before seeding).
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../src/db/migrate.js";

const PORT = 55436;
const DATA_DIR = ".pgdata-upgrade-proof";
const DB_NAME = "laundry_upgrade_0025_0027";

async function main() {
  const drizzleDir = resolve("drizzle");
  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };

  // Build a temporary migrations folder containing ONLY 0000..0025
  const pre0026Dir = join(tmpdir(), `laundry-pre0026-${Date.now()}`);
  mkdirSync(join(pre0026Dir, "meta"), { recursive: true });
  const preEntries = journal.entries.filter(e => !e.tag.startsWith("0026_") && !e.tag.startsWith("0027_"));
  if (preEntries.length !== journal.entries.length - 2) {
    throw new Error(`Expected exactly 2 post-0025 migrations (0026, 0027), got ${journal.entries.length - preEntries.length}`);
  }
  writeFileSync(
    join(pre0026Dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: preEntries }, null, 2),
  );
  for (const entry of preEntries) {
    const src = join(drizzleDir, `${entry.tag}.sql`);
    writeFileSync(join(pre0026Dir, `${entry.tag}.sql`), readFileSync(src, "utf8"));
  }

  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres_upgrade_only",
    port: PORT,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: msg => console.error(String(msg)),
  });

  try {
    await server.initialise();
    await server.start();
    const adminUrl = `postgres://postgres:postgres_upgrade_only@127.0.0.1:${PORT}/postgres`;
    const dbUrl = `postgres://postgres:postgres_upgrade_only@127.0.0.1:${PORT}/${DB_NAME}`;

    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }

    // 1. Apply 0000..0025 ONLY
    await runMigrations(dbUrl, pre0026Dir);

    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      // 2. Seed pre-0026/0027 populated fixtures directly on the 0025 schema:
      //    (a) active claim with direct 'verified' evidence attachment and NO legal hold row
      //    (b) partner invoice line with TWO active disputes ('open' older + 'investigating' newer)
      const org = (await client.query(`INSERT INTO organizations (name) VALUES ('Upgrade Proof Org') RETURNING id`)).rows[0].id as string;
      const user = (await client.query(
        `INSERT INTO users (phone, display_name) VALUES ('+79990001122', 'Upgrade Tester') RETURNING id`,
      )).rows[0].id as string;
      const partner = (await client.query(
        `INSERT INTO partners (organization_id, name) VALUES ($1, 'Upgrade Partner') RETURNING id`,
        [org],
      )).rows[0].id as string;
      const contract = (await client.query(
        `INSERT INTO partner_contracts (partner_id, version, effective_from, terms_json) VALUES ($1, 'v1', NOW() - INTERVAL '1 day', '{}'::jsonb) RETURNING id`,
        [partner],
      )).rows[0].id as string;
      const svc = (await client.query(
        `INSERT INTO services (organization_id, code, name, unit) VALUES ($1, 'wash-up', 'Wash', 'kg') RETURNING id`,
        [org],
      )).rows[0].id as string;
      const city = (await client.query(
        `INSERT INTO cities (organization_id, name) VALUES ($1, 'Upgrade City') RETURNING id`,
        [org],
      )).rows[0].id as string;
      const building = (await client.query(
        `INSERT INTO buildings (organization_id, city_id, address) VALUES ($1, $2, 'Upgrade St 1') RETURNING id`,
        [org, city],
      )).rows[0].id as string;
      const addr = (await client.query(
        `INSERT INTO customer_addresses (organization_id, customer_id, building_id, apartment) VALUES ($1, $2, $3, '1') RETURNING id`,
        [org, user, building],
      )).rows[0].id as string;
      const plan = (await client.query(
        `INSERT INTO tariff_plans (organization_id, code, name) VALUES ($1, 'upg-base', 'Upgrade Base') RETURNING id`,
        [org],
      )).rows[0].id as string;
      const tv = (await client.query(
        `INSERT INTO tariff_versions (plan_id, version, effective_from, terms_version, snapshot_json, published)
         VALUES ($1, 'v1', NOW() - INTERVAL '1 day', 'terms-v1', '{}'::jsonb, TRUE) RETURNING id`,
        [plan],
      )).rows[0].id as string;
      const quote = (await client.query(
        `INSERT INTO quotes (organization_id, customer_id, tariff_version_id, state, snapshot_json, quote_hash, total_kopeks, expires_at)
         VALUES ($1, $2, $3, 'accepted', '{}'::jsonb, 'qh-upg-1', 2000, NOW() + INTERVAL '1 day') RETURNING id`,
        [org, user, tv],
      )).rows[0].id as string;
      const order = (await client.query(
        `INSERT INTO orders (organization_id, customer_id, address_id, quote_id, public_number, lifecycle_state, terms_version, accepted_quote_hash)
         VALUES ($1, $2, $3, $4, 'LA-UPG-001', 'delivered', 'terms-v1', 'qh-upg-1') RETURNING id`,
        [org, user, addr, quote],
      )).rows[0].id as string;
      const orderLine = (await client.query(
        `INSERT INTO order_lines (order_id, service_id, tier, quoted_quantity, unit, quoted_amount_kopeks, tariff_snapshot_json)
         VALUES ($1, $2, 'economy', 1, 'kg', 2000, '{}'::jsonb) RETURNING id`,
        [order, svc],
      )).rows[0].id as string;

      // (a) Active claim + direct verified evidence asset WITHOUT legal hold
      const claim = (await client.query(
        `INSERT INTO claims (organization_id, order_id, opened_by, claim_type, state, description)
         VALUES ($1, $2, $3, 'damage', 'investigating', 'Pre-0026 claim') RETURNING id`,
        [org, order, user],
      )).rows[0].id as string;
      const asset = (await client.query(
        `INSERT INTO evidence_assets (organization_id, owner_type, owner_id, object_key, sha256, purpose, status, created_by)
         VALUES ($1, 'claim', $2, 'claims/pre0026.jpg', repeat('b', 64), 'claim', 'verified', $3) RETURNING id`,
        [org, claim, user],
      )).rows[0].id as string;

      // (b) Partner invoice line + 2 duplicate active disputes (allowed in 0025, deduplicated in 0027)
      const accrual = (await client.query(
        `INSERT INTO partner_service_accruals (organization_id, partner_id, order_line_id, contract_id, quantity, amount_kopeks, status, disputed)
         VALUES ($1, $2, $3, $4, 1, 1200, 'accrued', TRUE) RETURNING id`,
        [org, partner, orderLine, contract],
      )).rows[0].id as string;
      const pInv = (await client.query(
        `INSERT INTO partner_invoices (organization_id, partner_id, number, period_start, period_end, total_kopeks)
         VALUES ($1, $2, 'PINV-UPG-1', NOW() - INTERVAL '1 day', NOW(), 1200) RETURNING id`,
        [org, partner],
      )).rows[0].id as string;
      const pLine = (await client.query(
        `INSERT INTO partner_invoice_lines (invoice_id, accrual_id, amount_kopeks, state)
         VALUES ($1, $2, 1200, 'disputed') RETURNING id`,
        [pInv, accrual],
      )).rows[0].id as string;

      const olderDispute = (await client.query(
        `INSERT INTO partner_disputes (organization_id, invoice_line_id, opened_by, reason, state, opened_at)
         VALUES ($1, $2, $3, 'Older duplicate open dispute', 'open', NOW() - INTERVAL '2 hours') RETURNING id`,
        [org, pLine, user],
      )).rows[0].id as string;
      const newerDispute = (await client.query(
        `INSERT INTO partner_disputes (organization_id, invoice_line_id, opened_by, reason, state, opened_at)
         VALUES ($1, $2, $3, 'Newer surviving investigating dispute', 'investigating', NOW() - INTERVAL '1 hour') RETURNING id`,
        [org, pLine, user],
      )).rows[0].id as string;

      const beforeAsset = (await client.query(
        `SELECT status, legal_hold_count FROM evidence_assets WHERE id = $1`,
        [asset],
      )).rows[0];
      const beforeHolds = (await client.query(
        `SELECT count(*)::int AS cnt FROM evidence_legal_holds WHERE asset_id = $1 AND released_at IS NULL`,
        [asset],
      )).rows[0].cnt as number;
      const beforeDisputes = (await client.query(
        `SELECT id, state FROM partner_disputes WHERE invoice_line_id = $1 ORDER BY opened_at ASC`,
        [pLine],
      )).rows;

      console.log("BEFORE_0026_0027:", JSON.stringify({
        asset: beforeAsset,
        activeHolds: beforeHolds,
        disputes: beforeDisputes,
      }));
      if (beforeAsset.status !== "verified" || beforeAsset.legal_hold_count !== 0 || beforeHolds !== 0) {
        throw new Error("Pre-upgrade asset fixture mismatch");
      }
      if (beforeDisputes.length !== 2) {
        throw new Error("Pre-upgrade duplicate disputes fixture mismatch");
      }

      // 3. Query baseline environment + outbox state before applying 0026 + 0027
      const postgresVersion = ((await client.query<{ version: string }>(`SELECT version()`)).rows[0]?.version ?? "unknown");
      const beforeOutboxStuck = (await client.query(`
        SELECT count(*)::int AS cnt
        FROM outbox_events
        WHERE state IN ('failed', 'processing')
      `)).rows[0].cnt as number;

      // 4. Apply 0026 + 0027 onto the populated 0025 database
      await runMigrations(dbUrl, drizzleDir);

      const afterAsset = (await client.query(
        `SELECT status, legal_hold_count FROM evidence_assets WHERE id = $1`,
        [asset],
      )).rows[0];
      const afterHolds = (await client.query(
        `SELECT id, reason, released_at FROM evidence_legal_holds WHERE asset_id = $1`,
        [asset],
      )).rows;
      const afterDisputes = (await client.query(
        `SELECT id, state FROM partner_disputes WHERE invoice_line_id = $1 ORDER BY opened_at ASC`,
        [pLine],
      )).rows;

      console.log("AFTER_0026_0027:", JSON.stringify({
        asset: afterAsset,
        holds: afterHolds,
        disputes: afterDisputes,
      }));

      // Assert 0026 + 0027 effects:
      if (afterAsset.status !== "legal_hold" || afterAsset.legal_hold_count !== 1) {
        throw new Error(`Expected asset legal_hold + legal_hold_count=1, got ${JSON.stringify(afterAsset)}`);
      }
      if (afterHolds.length !== 1 || afterHolds[0].reason !== "backfill_active_claim_direct_attachment" || afterHolds[0].released_at !== null) {
        throw new Error(`Expected 1 active backfill hold, got ${JSON.stringify(afterHolds)}`);
      }
      const olderAfter = afterDisputes.find(d => d.id === olderDispute);
      const newerAfter = afterDisputes.find(d => d.id === newerDispute);
      if (olderAfter?.state !== "resolved" || newerAfter?.state !== "investigating") {
        throw new Error(`Expected older resolved and newer investigating, got ${JSON.stringify(afterDisputes)}`);
      }

      // Assert partial unique index blocks inserting a second active dispute
      let uniqueIndexEnforced = false;
      try {
        await client.query(
          `INSERT INTO partner_disputes (organization_id, invoice_line_id, opened_by, reason, state)
           VALUES ($1, $2, $3, 'Should fail unique index', 'open')`,
          [org, pLine, user],
        );
      } catch (err) {
        const pgErr = err as { code?: string; message?: string; constraint?: string };
        if (
          pgErr.code === "23505"
          || pgErr.constraint === "partner_disputes_one_open_per_line_unique"
          || (pgErr.message ?? "").includes("partner_disputes_one_open_per_line_unique")
        ) {
          uniqueIndexEnforced = true;
        } else {
          throw err;
        }
      }
      if (!uniqueIndexEnforced) {
        throw new Error("partner_disputes_one_open_per_line_unique did not block duplicate active dispute");
      }

      // 5. Repeatability: re-running full migrations is a strict no-op
      await runMigrations(dbUrl, drizzleDir);
      const repeatHolds = (await client.query(
        `SELECT count(*)::int AS cnt FROM evidence_legal_holds WHERE asset_id = $1`,
        [asset],
      )).rows[0].cnt as number;
      if (repeatHolds !== 1) {
        throw new Error(`Re-running migrations duplicated holds: ${repeatHolds}`);
      }
      const repeatAsset = (await client.query(
        `SELECT status, legal_hold_count FROM evidence_assets WHERE id = $1`,
        [asset],
      )).rows[0];
      if (repeatAsset?.status !== "legal_hold" || repeatAsset?.legal_hold_count !== 1) {
        throw new Error(`Re-running migrations mutated evidence_assets: ${JSON.stringify(repeatAsset)}`);
      }
      const repeatDisputes = (await client.query(
        `SELECT id, state FROM partner_disputes WHERE invoice_line_id = $1 ORDER BY opened_at ASC`,
        [pLine],
      )).rows;
      const repeatOlder = repeatDisputes.find(d => d.id === olderDispute);
      const repeatNewer = repeatDisputes.find(d => d.id === newerDispute);
      if (repeatOlder?.state !== "resolved" || repeatNewer?.state !== "investigating") {
        throw new Error(`Re-running migrations mutated partner_disputes: ${JSON.stringify(repeatDisputes)}`);
      }

      // 6. Legacy-data diagnostic checks (Item 4):
      const diagDuplicateOpenDisputes = (await client.query(`
        SELECT invoice_line_id, count(*)::int AS active_cnt
        FROM partner_disputes
        WHERE state IN ('open', 'investigating')
        GROUP BY invoice_line_id
        HAVING count(*) > 1
      `)).rows;
      const diagDisputedFlagDrift = (await client.query(`
        SELECT pil.id AS line_id, pil.state AS line_state, psa.disputed AS accrual_disputed,
               EXISTS (
                 SELECT 1 FROM partner_disputes pd
                 WHERE pd.invoice_line_id = pil.id AND pd.state IN ('open', 'investigating')
               ) AS has_active_dispute
        FROM partner_invoice_lines pil
        JOIN partner_service_accruals psa ON psa.id = pil.accrual_id
        WHERE psa.disputed <> EXISTS (
          SELECT 1 FROM partner_disputes pd
          WHERE pd.invoice_line_id = pil.id AND pd.state IN ('open', 'investigating')
        )
      `)).rows;
      const diagOverCreditedLines = (await client.query(`
        SELECT pil.id AS line_id, pil.amount_kopeks, COALESCE(SUM(pcn.amount_kopeks), 0)::bigint AS credited_kopeks
        FROM partner_invoice_lines pil
        JOIN partner_credit_notes pcn
          ON pcn.original_line_id = pil.id
         AND pcn.state <> 'rejected'
        GROUP BY pil.id, pil.amount_kopeks
        HAVING COALESCE(SUM(pcn.amount_kopeks), 0) > pil.amount_kopeks
      `)).rows;
      const diagStuckOutbox = (await client.query(`
        SELECT count(*)::int AS cnt
        FROM outbox_events
        WHERE state IN ('failed', 'processing')
      `)).rows[0].cnt as number;
      const historicalOutboxRequeueStatus = beforeOutboxStuck === 0 && diagStuckOutbox === 0
        ? "NOT_APPLICABLE_0_AFFECTED"
        : "AFFECTED_ROWS_PRESENT";

      console.log("LEGACY_DIAGNOSTICS:", JSON.stringify({
        environment: {
          nodeVersion: process.version,
          postgresVersion,
          scope: "disposable_embedded_pg:laundry_upgrade_0025_0027",
        },
        duplicateActiveDisputesRemaining: diagDuplicateOpenDisputes.length,
        disputedFlagDriftRows: diagDisputedFlagDrift.length,
        overCreditedLines: diagOverCreditedLines.length,
        beforeStuckOutboxRows: beforeOutboxStuck,
        afterStuckOutboxRows: diagStuckOutbox,
        stuckOutboxRows: diagStuckOutbox,
        historicalOutboxRequeueStatus,
        uniqueIndexEnforced,
        repeatMigrationNoOp: true,
      }));
      if (
        diagDuplicateOpenDisputes.length !== 0
        || diagDisputedFlagDrift.length !== 0
        || diagOverCreditedLines.length !== 0
        || diagStuckOutbox !== 0
      ) {
        throw new Error("Legacy diagnostic check found unresolved anomalies");
      }
      console.log("POPULATED_UPGRADE_0025_TO_0027_PASS");
    } finally {
      await client.end();
    }
  } finally {
    rmSync(pre0026Dir, { recursive: true, force: true });
    await server.stop().catch(() => undefined);
    try {
      rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore Windows handle release lag */ }
  }
}

main().catch(err => {
  console.error("POPULATED_UPGRADE_FAILED:", err);
  process.exit(1);
});
