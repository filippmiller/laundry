import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { paymentEvents, paymentIntents, refunds } from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder } from "./operations-fixtures.js";
import {
  capturePayment, createCustomerInvoice, handlePaymentWebhook, refundPayment,
} from "../src/services/finance.js";
import {
  markChargeback, paymentDrift, processPaymentInbox, requeueFailedPaymentEvents,
} from "../src/services/payment-inbox.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Payment inbox, chargebacks and drift", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function orderWithInvoice() {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const invoice = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });
    return { ...f, invoice, finance };
  }

  it("applies a captured webhook exactly once and marks the inbox row processed", async () => {
    const f = await orderWithInvoice();
    const [intent] = await db.insert(paymentIntents).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      provider: "fake",
      amountKopeks: f.invoice.totalKopeks,
      state: "pending",
      idempotencyKey: `manual-${rid()}`,
    }).returning();
    const eventId = `evt-${rid()}`;
    await handlePaymentWebhook(db, {
      provider: "fake", providerEventId: eventId, eventType: "captured",
      payload: { organizationId: f.organizationId, paymentIntentId: intent.id },
    });

    await processPaymentInbox(db, { limit: 200 });
    const [event] = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId));
    expect(event.state).toBe("processed");
    expect(event.processedAt).toBeTruthy();
    const [stored] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(stored.state).toBe("captured");

    // Replaying the same provider event is a duplicate at the inbox boundary.
    const replay = await handlePaymentWebhook(db, {
      provider: "fake", providerEventId: eventId, eventType: "captured",
      payload: { organizationId: f.organizationId, paymentIntentId: intent.id },
    });
    expect(replay.status).toBe("duplicate");
  });

  it("keeps an unknown event type failed and re-arms it for another attempt", async () => {
    const f = await orderWithInvoice();
    const [intent] = await db.insert(paymentIntents).values({
      organizationId: f.organizationId, orderId: f.orderId, provider: "fake",
      amountKopeks: f.invoice.totalKopeks, state: "pending", idempotencyKey: `manual-${rid()}`,
    }).returning();
    const eventId = `evt-${rid()}`;
    await handlePaymentWebhook(db, {
      provider: "fake", providerEventId: eventId, eventType: "teleported",
      payload: { organizationId: f.organizationId, paymentIntentId: intent.id },
    });
    await processPaymentInbox(db, { limit: 200 });

    const [failed] = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId));
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("UNKNOWN_EVENT_TYPE");
    expect(failed.attempts).toBe(1);

    const requeued = await requeueFailedPaymentEvents(db);
    expect(requeued.requeued).toBeGreaterThanOrEqual(1);
    const [armed] = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, eventId));
    expect(armed.state).toBe("received");
  });

  it("chargeback blocks refunds until a human resolves it", async () => {
    const f = await orderWithInvoice();
    const capture = await capturePayment(db, f.finance, {
      orderId: f.orderId, amountKopeks: f.invoice.totalKopeks, key: `cap-${rid()}`,
    });
    const dispute = await markChargeback(db, f.finance, {
      paymentIntentId: capture.paymentIntentId, reason: "Ð±Ð°Ð½Ðº ÐºÐ»Ð¸ÐµÐ½Ñ‚Ð° Ð¾ÑÐ¿Ð¾Ñ€Ð¸Ð» Ð¿Ð»Ð°Ñ‚Ñ‘Ð¶", key: `cb-${rid()}`,
    });
    expect(dispute.state).toBe("disputed");
    await expect(refundPayment(db, f.finance, {
      paymentIntentId: capture.paymentIntentId, amountKopeks: 1, reason: "Ð²Ð¾Ð·Ð²Ñ€Ð°Ñ‚", key: `ref-${rid()}`,
    })).rejects.toThrow("PAYMENT_NOT_REFUNDABLE");
  });

  it("detects a stored intent state that disagrees with completed refunds", async () => {
    const f = await orderWithInvoice();
    const capture = await capturePayment(db, f.finance, {
      orderId: f.orderId, amountKopeks: f.invoice.totalKopeks, key: `cap-${rid()}`,
    });
    await db.insert(refunds).values({
      organizationId: f.organizationId,
      paymentIntentId: capture.paymentIntentId,
      amountKopeks: 1,
      state: "completed",
      reason: "Ñ€ÑƒÑ‡Ð½Ð°Ñ ÐºÐ¾Ñ€Ñ€ÐµÐºÑ‚Ð¸Ñ€Ð¾Ð²ÐºÐ°",
      idempotencyKey: `manual-refund-${rid()}`,
    });

    const drift = await paymentDrift(db, f.finance);
    expect(drift.map(row => row.paymentIntentId)).toContain(capture.paymentIntentId);

    await db.update(paymentIntents).set({ state: "partially_refunded" })
      .where(eq(paymentIntents.id, capture.paymentIntentId));
    const after = await paymentDrift(db, f.finance);
    expect(after.map(row => row.paymentIntentId)).not.toContain(capture.paymentIntentId);
  });
});

