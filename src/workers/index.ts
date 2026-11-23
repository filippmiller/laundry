import { sql } from "drizzle-orm";
import { organizations } from "../db/schema.js";
import { createDb, requireDatabaseUrl, type Db } from "../db/client.js";
import { expireDueHolds, reconcileCapacity } from "../domain/slot-reservation.js";
import { ensureSystemPrincipal } from "../services/auth.js";
import { processPendingRefunds } from "../services/finance.js";
import { processPaymentInbox, requeueFailedPaymentEvents } from "../services/payment-inbox.js";
import { processOutbox, requeueFailedOutboxEvents } from "../services/outbox.js";
import { runEvidenceRetentionSweep } from "../services/workspace.js";

export async function runOnceWithDb(db: Db) {
  const summary = {
    organizations: 0, expired: 0, mismatches: 0, pendingOutbox: 0,
    inboxProcessed: 0, inboxFailed: 0, inboxRequeued: 0,
    outboxProcessed: 0, outboxFailed: 0, outboxDeadLettered: 0, outboxRequeued: 0,
    evidenceExpired: 0,
    refundsCompleted: 0, refundsErrored: 0,
  };
  const orgs = await db.select().from(organizations);
  summary.organizations = orgs.length;
  for (const org of orgs) {
    const principal = await ensureSystemPrincipal(db, org.id);
    const swept = await expireDueHolds(db, { principal, limit: 200 });
    summary.expired += swept.expired;
    const refunded = await processPendingRefunds(db, principal, { limit: 100 });
    summary.refundsCompleted += refunded.completed;
    summary.refundsErrored += refunded.errored;
    const mismatches = await reconcileCapacity(db, org.id);
    summary.mismatches += mismatches.length;
    const pending = await db.execute(sql`
      SELECT count(*)::int AS count FROM outbox_events
      WHERE organization_id = ${org.id} AND state = 'pending'
    `);
    summary.pendingOutbox += Number((pending.rows as unknown as Array<{ count: number }>)[0]?.count ?? 0);
  }
  const outboxRequeued = await requeueFailedOutboxEvents(db, { onlyDue: true });
  summary.outboxRequeued = outboxRequeued.requeued;
  const outbox = await processOutbox(db);
  summary.outboxProcessed = outbox.processed;
  summary.outboxFailed = outbox.failed;
  summary.outboxDeadLettered = outbox.deadLettered;
  const requeued = await requeueFailedPaymentEvents(db);
  summary.inboxRequeued = requeued.requeued;
  const inbox = await processPaymentInbox(db);
  summary.inboxProcessed = inbox.processed;
  summary.inboxFailed = inbox.failed;
  const retention = await runEvidenceRetentionSweep(db);
  summary.evidenceExpired = retention.expired;
  return summary;
}

export async function runOnce(url = requireDatabaseUrl()) {
  const { db, pool } = createDb(url, { max: 4 });
  try {
    return await runOnceWithDb(db);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("worker.js");
if (invokedDirectly) {
  if (process.argv.includes("--once")) {
    runOnce().then(summary => {
      console.log("worker cycle", JSON.stringify(summary));
    }, error => {
      console.error(error);
      process.exitCode = 1;
    });
  } else {
    const { db, pool } = createDb(requireDatabaseUrl(), { max: 4 });
    const interval = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);
    let running = false;
    let shuttingDown = false;

    const tick = async () => {
      if (running || shuttingDown) return;
      running = true;
      try {
        const result = await runOnceWithDb(db);
        console.log("worker cycle", JSON.stringify(result));
      } catch (error) {
        console.error("worker cycle failed", error);
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, interval);

    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(timer);
      await pool.end();
    };
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
  }
}

