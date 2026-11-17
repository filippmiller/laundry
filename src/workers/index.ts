import { sql } from "drizzle-orm";
import { organizations } from "../db/schema.js";
import { createDb, requireDatabaseUrl } from "../db/client.js";
import { expireDueHolds, reconcileCapacity } from "../domain/slot-reservation.js";
import { ensureSystemPrincipal } from "../services/auth.js";
import { processPaymentInbox, requeueFailedPaymentEvents } from "../services/payment-inbox.js";
import { processOutbox, requeueFailedOutboxEvents } from "../services/outbox.js";

export async function runOnce(url = requireDatabaseUrl()) {
  const { db, pool } = createDb(url, { max: 4 });
  const summary = {
    organizations: 0, expired: 0, mismatches: 0, pendingOutbox: 0,
    inboxProcessed: 0, inboxFailed: 0, inboxRequeued: 0,
    outboxProcessed: 0, outboxFailed: 0, outboxRequeued: 0,
  };
  try {
    const orgs = await db.select().from(organizations);
    summary.organizations = orgs.length;
    for (const org of orgs) {
      const principal = await ensureSystemPrincipal(db, org.id);
      const swept = await expireDueHolds(db, { principal, limit: 200 });
      summary.expired += swept.expired;
      const mismatches = await reconcileCapacity(db, org.id);
      summary.mismatches += mismatches.length;
      const pending = await db.execute(sql`
        SELECT count(*)::int AS count FROM outbox_events
        WHERE organization_id = ${org.id} AND state = 'pending'
      `);
      summary.pendingOutbox += Number((pending.rows as unknown as Array<{ count: number }>)[0]?.count ?? 0);
    }
    const outboxRequeued = await requeueFailedOutboxEvents(db);
    summary.outboxRequeued = outboxRequeued.requeued;
    const outbox = await processOutbox(db);
    summary.outboxProcessed = outbox.processed;
    summary.outboxFailed = outbox.failed;
    const requeued = await requeueFailedPaymentEvents(db);
    summary.inboxRequeued = requeued.requeued;
    const inbox = await processPaymentInbox(db);
    summary.inboxProcessed = inbox.processed;
    summary.inboxFailed = inbox.failed;
    return summary;
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("worker.js");
if (invokedDirectly) {
  runOnce().then(async summary => {
    console.log("worker cycle", JSON.stringify(summary));
    if (!process.argv.includes("--once")) {
      const interval = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);
      setInterval(() => {
        runOnce().then(result => console.log("worker cycle", JSON.stringify(result)))
          .catch(error => console.error("worker cycle failed", error));
      }, interval);
    }
  }, error => {
    console.error(error);
    process.exitCode = 1;
  });
}

