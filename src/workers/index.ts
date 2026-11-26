import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { organizations } from "../db/schema.js";
import { createDb, requireDatabaseUrl, type Db } from "../db/client.js";
import { expireDueHolds, reconcileCapacity } from "../domain/slot-reservation.js";
import { ensureSystemPrincipal } from "../services/auth.js";
import { processPendingRefunds } from "../services/finance.js";
import { processPaymentInbox, requeueFailedPaymentEvents } from "../services/payment-inbox.js";
import { processOutbox, requeueFailedOutboxEvents } from "../services/outbox.js";
import { runEvidenceRetentionSweep } from "../services/workspace.js";

/**
 * The worker heartbeat.
 *
 * The worker is a poller: it serves no HTTP endpoint, so the only honest question about its
 * health is "did it complete a recent cycle?". The heartbeat file answers exactly that — the
 * deployment's healthcheck reads it instead of probing a port the worker never opens.
 *
 * The success timestamp is deliberately sticky. A failed cycle records the failure, but it must
 * NOT refresh `lastSuccessAt`: a worker stuck in a crash loop would otherwise look healthy for
 * as long as it keeps failing.
 */
export interface WorkerHeartbeat {
  /** ISO timestamp of the last SUCCESSFUL cycle, or null when no cycle has ever succeeded. */
  lastSuccessAt: string | null;
  /** The summary of that last successful cycle (counts of what it processed). */
  lastSuccessSummary: WorkerCycleSummary | null;
  /** ISO timestamp of the last failed cycle, or null when no cycle has ever failed. */
  lastFailureAt: string | null;
  /** Message of the last failure, kept for the operator reading the file. */
  lastFailureMessage: string | null;
  /** ISO timestamp of the last write to this file, successful or not. */
  updatedAt: string;
}

/** The per-cycle counters a successful cycle reports. */
export type WorkerCycleSummary = Record<string, number>;

/** Where the heartbeat is written when WORKER_HEARTBEAT_FILE is not set. */
export const DEFAULT_HEARTBEAT_FILE = "./.worker-heartbeat";

/**
 * The heartbeat file the worker writes and the healthcheck reads.
 *
 * Both sides resolve it through this function so the writer and the reader can never disagree
 * about the path — a mismatch would look exactly like a dead worker.
 */
export function heartbeatFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WORKER_HEARTBEAT_FILE?.trim();
  return configured ? configured : DEFAULT_HEARTBEAT_FILE;
}

/**
 * The heartbeat of a successful cycle.
 *
 * Pure: it takes the summary and the moment the cycle finished, so the unit test can assert on
 * the timestamps without touching the filesystem or the clock.
 */
export function buildHeartbeat(summary: WorkerCycleSummary, now: Date = new Date()): WorkerHeartbeat {
  const at = now.toISOString();
  return {
    lastSuccessAt: at,
    lastSuccessSummary: summary,
    lastFailureAt: null,
    lastFailureMessage: null,
    updatedAt: at,
  };
}

/**
 * The heartbeat after a failed cycle.
 *
 * Pure: the previous heartbeat is passed in, and only the failure fields move. `lastSuccessAt`
 * is carried over untouched, which is the whole point — a failing cycle must age the success
 * timestamp instead of renewing it.
 */
export function markCycleFailure(
  previous: WorkerHeartbeat | null,
  error: unknown,
  now: Date = new Date(),
): WorkerHeartbeat {
  const at = now.toISOString();
  return {
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastSuccessSummary: previous?.lastSuccessSummary ?? null,
    lastFailureAt: at,
    lastFailureMessage: error instanceof Error ? error.message : String(error),
    updatedAt: at,
  };
}

/** Reads the heartbeat file, or null when it is missing or unreadable. */
export function readHeartbeat(filePath: string = heartbeatFilePath()): WorkerHeartbeat | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as WorkerHeartbeat;
  } catch {
    return null;
  }
}

/**
 * Writes the heartbeat file atomically.
 *
 * The healthcheck may read the file at any moment, so it must never observe a half-written
 * JSON document: the content goes to a sibling temporary file that is then renamed over the
 * target, which is atomic on both POSIX and Windows.
 */
export function writeHeartbeat(heartbeat: WorkerHeartbeat, filePath: string = heartbeatFilePath()): void {
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

/** Records a successful cycle and returns the heartbeat that was written. */
export function recordCycleSuccess(
  summary: WorkerCycleSummary,
  now: Date = new Date(),
  filePath: string = heartbeatFilePath(),
): WorkerHeartbeat {
  const heartbeat = buildHeartbeat(summary, now);
  writeHeartbeat(heartbeat, filePath);
  return heartbeat;
}

/** Records a failed cycle and returns the heartbeat that was written. */
export function recordCycleFailure(
  error: unknown,
  now: Date = new Date(),
  filePath: string = heartbeatFilePath(),
): WorkerHeartbeat {
  const heartbeat = markCycleFailure(readHeartbeat(filePath), error, now);
  writeHeartbeat(heartbeat, filePath);
  return heartbeat;
}

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

/**
 * The module is imported by the unit tests and by tooling, so it may only start a loop when it
 * is the process entry point. Comparing the resolved entry point with this file is exact; the
 * `worker.js` suffix is the compiled entry point. Paths inside node_modules are ignored on
 * purpose — a test runner lives there and is never the worker.
 */
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolvedEntry = resolve(entry);
  if (resolvedEntry.includes(`${sep}node_modules${sep}`)) return false;
  if (resolvedEntry === fileURLToPath(import.meta.url)) return true;
  return resolvedEntry.endsWith(`${sep}worker.js`);
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  if (process.argv.includes("--once")) {
    runOnce().then(summary => {
      console.log("worker cycle", JSON.stringify(summary));
      recordCycleSuccess(summary);
    }, error => {
      console.error(error);
      recordCycleFailure(error);
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
        // Only a finished cycle refreshes the heartbeat: this is the signal the deployment's
        // healthcheck reads to decide whether the worker is alive and cycling.
        recordCycleSuccess(result);
      } catch (error) {
        console.error("worker cycle failed", error);
        // The failure is recorded, but the success timestamp stays where it was, so a worker
        // that keeps failing ages out and is reported unhealthy.
        recordCycleFailure(error);
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

