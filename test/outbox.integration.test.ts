import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { notifications, outboxEvents } from "../src/db/schema.js";
import { seedFullOrder } from "./operations-fixtures.js";
import { processOutbox, requeueFailedOutboxEvents } from "../src/services/outbox.js";

async function drain(db: Db) {
  let processed = 0;
  let failed = 0;
  for (;;) {
    const result = await processOutbox(db, { limit: 500 });
    processed += result.processed;
    failed += result.failed;
    if (result.claimed === 0) break;
  }
  return { processed, failed };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("Outbox notification worker", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  it("turns one order's lifecycle events into exactly one notification each", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await drain(db);

    const orderEvents = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, f.organizationId),
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, f.orderId),
    ));
    const mapped = orderEvents.filter(event => [
      "order.confirmed", "order.scheduled",
    ].includes(event.eventType));
    expect(mapped).toHaveLength(2);
    for (const event of mapped) {
      expect(event.state).toBe("processed");
      const sent = await db.select().from(notifications).where(and(
        eq(notifications.organizationId, f.organizationId),
        eq(notifications.dedupeKey, `outbox:${event.id}`),
      ));
      expect(sent).toHaveLength(1);
      expect(sent[0].recipientId).toBe(f.principal.userId);
      expect(sent[0].orderId).toBe(f.orderId);
    }

    // Replaying the worker must not duplicate anything.
    await drain(db);
    for (const event of mapped) {
      const sent = await db.select().from(notifications).where(and(
        eq(notifications.organizationId, f.organizationId),
        eq(notifications.dedupeKey, `outbox:${event.id}`),
      ));
      expect(sent).toHaveLength(1);
    }
  });

  it("marks informational events processed without inventing notifications", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await drain(db);
    const informational = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, f.organizationId),
      eq(outboxEvents.eventType, "quote.created"),
    ));
    expect(informational.length).toBeGreaterThanOrEqual(1);
    for (const event of informational) {
      expect(event.state).toBe("processed");
      const invented = await db.select().from(notifications).where(and(
        eq(notifications.organizationId, f.organizationId),
        eq(notifications.dedupeKey, `outbox:${event.id}`),
      ));
      expect(invented).toHaveLength(0);
    }
  });

  it("keeps an unmappable event visible as failed and re-arms it", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "payment",
      aggregateId: randomUUID(),
      eventType: "payment.captured",
      payloadJson: { orderId: randomUUID() },
    });
    await drain(db);

    const [failed] = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, f.organizationId),
      eq(outboxEvents.state, "failed"),
    ));
    expect(failed).toBeTruthy();
    expect(failed.error).toBe("ORDER_NOT_FOUND");

    const requeued = await requeueFailedOutboxEvents(db);
    expect(requeued.requeued).toBeGreaterThanOrEqual(1);
    const [armed] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, failed.id));
    expect(armed.state).toBe("pending");
  });

  it("does not duplicate notifications the screens already send directly", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await drain(db);
    // intake writes intake_confirmed and delivery writes delivery_confirmed itself; the worker
    // must not generate an outbox:* notification for those event types.
    for (const eventType of ["order.accept_handoff", "delivery.delivered"]) {
      const events = await db.select().from(outboxEvents).where(and(
        eq(outboxEvents.organizationId, f.organizationId),
        eq(outboxEvents.eventType, eventType),
      ));
      for (const event of events) {
        expect(event.state).toBe("processed");
        const duplicated = await db.select().from(notifications).where(and(
          eq(notifications.organizationId, f.organizationId),
          eq(notifications.dedupeKey, `outbox:${event.id}`),
        ));
        expect(duplicated).toHaveLength(0);
      }
    }
  });
});
