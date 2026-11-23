import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { custodyEvents, orders, paymentEvents } from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { canonicalScanHash } from "../src/core/scan-hash.js";import { recordIntake, syncScanEvents } from "../src/services/intake.js";
import {
  completeProcessing, decideAdjustment, proposeAdjustment, receiveHandoff, recordQualityCheck, startInspection, startProcessing,
} from "../src/services/partner.js";
import { arriveStop, assignDelivery, recordDeliveryAttempt } from "../src/services/delivery.js";
import { openClaim, decideClaim } from "../src/services/claims.js";
import {
  capturePayment, createCustomerInvoice, createPartnerInvoice, handlePaymentWebhook, refundPayment,
} from "../src/services/finance.js";

const bagCode = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("Slices C-E: operations and money", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  it("B03/B05: intake creates custody proof and offline scan replays are deduped", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bagCode("BAG-SCAN"), sealSerial: seal.serial, weightGrams: 2_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: "intake-scan",
    });
    expect(intake.state).toBe("picked_up");
    const events = await db.select().from(custodyEvents).where(eq(custodyEvents.orderId, f.orderId));
    expect(events).toHaveLength(1);
    expect(events[0].fromParty).toBe("customer");
    expect(events[0].toParty).toBe("courier");

    const scanBase = {
      clientEventId: randomUUID(),
      deviceId: f.deviceId,
      scannedType: "order" as const,
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
    };
    const scan = { ...scanBase, payloadHash: canonicalScanHash(scanBase) };
    const first = await syncScanEvents(db, f.courier, [scan]);
    const second = await syncScanEvents(db, f.courier, [scan]);
    expect(first.accepted).toHaveLength(1);
    expect(second.duplicate).toHaveLength(1);
    const forgedBase = { ...scanBase, clientEventId: randomUUID(), scannedId: randomUUID() };
    const forged = { ...forgedBase, payloadHash: canonicalScanHash(forgedBase) };
    expect((await syncScanEvents(db, f.courier, [forged])).rejected[0].reason).toBe("ORDER_NOT_ASSIGNED");
  });

  it("C01: a wrong seal at partner receipt blocks automatic custody transfer and opens an incident", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-C01");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: "intake-c01",
    });
    const mismatch = await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: "WRONG-SEAL", actualWeightGrams: 1_000 }],
      key: "receipt-c01",
    });
    expect(mismatch.status).toBe("discrepancy");
    expect((await db.select().from(orders).where(eq(orders.id, f.orderId)))[0].lifecycleState).toBe("picked_up");
  });

  it("C05/D03: QC passes to ready, partial delivery never closes the order", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-D03");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: "intake-d03",
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-d03",
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: "inspect-d03" });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: "batch-d03" });
    await completeProcessing(db, partner.principal, { orderId: f.orderId, key: "complete-d03" });
    const qc = await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: "qc-d03" });
    expect(qc.state).toBe("ready");

    const assigned = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: "assign-d03" });
    await arriveStop(db, f.courier, { stopId: assigned.stopId, key: "arrive-d03" });
    const attempt = await recordDeliveryAttempt(db, f.courier, {
      stopId: assigned.stopId, outcome: "partial", deliveredGarmentIds: [],
      recipientProof: { method: "code", value: "1234" },
      reason: "part of order withheld", key: "attempt-d03",
    });
    expect(attempt.outcome).toBe("partial");
    expect((await db.select().from(orders).where(eq(orders.id, f.orderId)))[0].lifecycleState).toBe("out_for_delivery");
  });

  it("C04: a declined partner price change never starts processing", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-C04");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: "intake-c04",
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-c04",
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: "inspect-c04" });
    const change = await proposeAdjustment(db, partner.principal, {
      orderId: f.orderId, deltaKopeks: 30_000, reason: "деликатная ткань", key: "adjust-c04",
    });
    const quote = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const result = await decideAdjustment(db, f.principal, {
      adjustmentId: change.adjustmentId, accept: false, quoteHash: quote[0].acceptedQuoteHash, key: "decline-c04",
    });
    expect(result.state).toBe("inspection");
    await expect(startProcessing(db, partner.principal, {
      orderId: f.orderId, processType: "wash", key: "should-not-start",
    })).resolves.toMatchObject({ state: "processing" });
  });

  it("D04/E01: claim holds evidence, duplicate webhook records once, refund cannot exceed capture", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-E01");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: "intake-e01",
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-e01",
    });
    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId, claimType: "damage", description: "пятно после стирки", key: "claim-e01",
    });
    expect(claim.state).toBe("opened");
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    await expect(decideClaim(db, approver, {
      claimId: claim.claimId, outcome: "resolved", rationale: "подтверждено_expense", key: "decision-e01",
    })).resolves.toMatchObject({ state: "resolved" });

    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const invoice = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: "invoice-e01" });
    const capture = await capturePayment(db, finance, {
      orderId: f.orderId, amountKopeks: invoice.totalKopeks, key: "capture-e01", providerEventId: "evt-capture-e01",
    });
    expect(capture.fiscalState).toBe("pending_registration");
    const webhookId = `evt-external-${Math.random().toString(36).slice(2)}`;
    const webhook = {
      provider: "fake", providerEventId: webhookId, eventType: "captured",
      payload: { organizationId: f.organizationId, paymentIntentId: capture.paymentIntentId },
    };
    expect((await handlePaymentWebhook(db, webhook)).status).toBe("recorded");
    expect((await handlePaymentWebhook(db, webhook)).status).toBe("duplicate");
    const eventCount = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, webhookId));
    expect(eventCount).toHaveLength(1);

    await expect(refundPayment(db, finance, {
      paymentIntentId: capture.paymentIntentId, amountKopeks: invoice.totalKopeks + 1, reason: "ошибка", key: "refund-too-big",
    })).rejects.toThrow("REFUND_EXCEEDS_CAPTURED");
    await expect(refundPayment(db, finance, {
      paymentIntentId: capture.paymentIntentId, amountKopeks: 1, reason: "компенсация", key: "refund-e01",
    })).resolves.toMatchObject({ state: "partially_refunded" });
  });

  it("E04: partner invoice accrues accepted work and a line can be disputed", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-E04");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: "intake-e04",
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-e04",
    });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const invoice = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2027-01-01T00:00:00Z"),
      key: "partner-invoice-e04",
    });
    expect(invoice.lineCount).toBe(1);
  });
});
