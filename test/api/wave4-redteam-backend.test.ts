import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  containerAssignments, containers, garmentEvidence, garments,
  ledgerJournals, orderLines, orders, organizations, partnerInvoiceLines, partnerInvoices,
  partnerServiceAccruals, paymentIntents, refunds, seals,
} from "../../src/db/schema.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { holdSlotPair } from "../../src/domain/slot-reservation.js";
import { completeShift } from "../../src/services/courier-shift.js";
import { listNotificationsPage } from "../../src/services/customer.js";
import {
  capturePayment, createCustomerInvoice, createPartnerPayout,
  disputePartnerLine, listPartnerCreditNotes, listPartnerPayouts,
  processPendingRefunds,
} from "../../src/services/finance.js";
import { syncScanEvents, type ScanEventInput } from "../../src/services/intake.js";
import { cancelOrder, getOrderTimeline, loadOrderView } from "../../src/services/orders.js";
import {
  exportMyPrivacyData, listGarmentEvidence, registerEvidence, uploadEvidence,
} from "../../src/services/workspace.js";
import { runOnceWithDb } from "../../src/workers/index.js";
import { makePrincipal, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder } from "../operations-fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 4 Red-Team Backend Remediations", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.WEB_ORIGIN = "http://localhost:5173";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 12 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function loginAs(organizationId: string, phone: string, roles: string[]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
    };
  }

  it("1. Keyset cursor preserves PostgreSQL microsecond precision (zero skipped rows on sub-ms ties)", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);

    // Insert 4 notifications within the SAME millisecond (.456xxxZ) with distinct microseconds.
    // With JS Date ms-truncation, cursor.ts rounds down to .456000Z and skips rows with .456789Z/.456500Z!
    const timestamps = [
      "2026-11-20T12:34:56.456789Z",
      "2026-11-20T12:34:56.456500Z",
      "2026-11-20T12:34:56.456250Z",
      "2026-11-20T12:34:56.456001Z",
    ];
    const insertedIds: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const id = rid();
      insertedIds.push(id);
      await db.execute(sql`
        INSERT INTO notifications (id, organization_id, recipient_id, channel, template, payload_json, dedupe_key, created_at)
        VALUES (${id}, ${seed.organizationId}, ${seed.userId}, 'push', ${`subms_${i}`}, '{}'::jsonb, ${`subms-dedupe-${id}`}, ${timestamps[i]}::timestamptz)
      `);
    }

    // Paginate 1 item at a time — must yield all 4 in exact microsecond descending order, zero skips.
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listNotificationsPage(db, principal, { limit: 1, cursor });
      for (const item of page.items) collected.push(item.id);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(insertedIds);

    // Privacy export also reads all 4 without skipping.
    const exported = await exportMyPrivacyData(db, principal);
    expect(exported.notifications.map(n => n.id)).toEqual(insertedIds);
  });

  it("2. CORS exposes pagination headers (X-Next-Cursor, X-Has-More, X-Total-Count, X-Total-Unread)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/claims",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    const exposed = String(res.headers["access-control-expose-headers"] ?? "");
    for (const header of ["X-Total-Unread", "X-Next-Cursor", "X-Has-More", "X-Total-Count"]) {
      expect(exposed).toContain(header);
    }
  });

  it("5. Closed shift revokes courier GET /orders/:id, GET /orders/:id/timeline, and listGarmentEvidence; active shift allows listGarmentEvidence", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const [garment] = await db.insert(garments).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      itemCode: `G-${rid().slice(0, 6)}`,
      category: "outerwear",
      description: "Wool coat",
      status: "accepted",
    }).returning();

    const bytes = Buffer.from("garment-evidence-bytes-redteam");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reg = await registerEvidence(db, f.courier, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256,
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      key: `ev-reg-${rid()}`,
    });
    await uploadEvidence(db, f.courier, {
      evidenceId: reg.evidenceId,
      bytes,
      mimeType: "image/jpeg",
      key: `ev-up-${rid()}`,
    });
    await db.insert(garmentEvidence).values({
      organizationId: f.organizationId,
      garmentId: garment.id,
      evidenceAssetId: reg.evidenceId,
    });

    // Active shift: courier can read order view, timeline, and garment evidence.
    const view = await loadOrderView(db, f.courier, f.orderId);
    expect(view.id).toBe(f.orderId);
    const timeline = await getOrderTimeline(db, f.courier, f.orderId);
    expect(Array.isArray(timeline)).toBe(true);
    const gEv = await listGarmentEvidence(db, f.courier, garment.id);
    expect(gEv.map(e => e.id)).toContain(reg.evidenceId);

    // Close the shift -> courier immediately loses access to order view, timeline, and garment evidence.
    await completeShift(db, f.courier, { shiftId: f.shiftId, key: `close-${rid()}` });

    await expect(loadOrderView(db, f.courier, f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getOrderTimeline(db, f.courier, f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listGarmentEvidence(db, f.courier, garment.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("6. Cross-actor/cross-tenant scan_events submission with foreign deviceId does NOT poison (device_id, client_event_id) for rightful owner", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const [foreignOrg] = await db.insert(organizations).values({
      name: `Attacker Org ${rid().slice(0, 8)}`,
    }).returning();
    const attackerId = await seedUser(db, foreignOrg.id);
    const attacker = makePrincipal(foreignOrg.id, attackerId, ["courier"]);

    const clientEventId = rid();
    const baseEvent = {
      clientEventId,
      deviceId: f.deviceId,
      scannedType: "order" as const,
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
    };
    const scanEvent: ScanEventInput = {
      ...baseEvent,
      payloadHash: canonicalScanHash(baseEvent),
    };

    // Attacker submits first using Actor A's (deviceId, clientEventId) -> rejected as DEVICE_NOT_OWNED
    const attackerRes = await syncScanEvents(db, attacker, [scanEvent]);
    expect(attackerRes.accepted).toEqual([]);
    expect(attackerRes.rejected).toEqual([{ clientEventId, reason: "DEVICE_NOT_OWNED" }]);

    // Rightful owner (Actor A) submits afterwards -> MUST be accepted cleanly (not blocked/poisoned)!
    const ownerRes = await syncScanEvents(db, f.courier, [scanEvent]);
    expect(ownerRes.accepted).toEqual([clientEventId]);
    expect(ownerRes.rejected).toEqual([]);
  });

  it("8. holdSlotPair locks all involved service_windows in deterministic order when replacing prior holds", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 2);
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);

    const first = await holdSlotPair(db, {
      principal,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      key: `pair-1-${rid()}`,
      ttlMinutes: 10,
    });
    const replaced = await holdSlotPair(db, {
      principal,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      releaseReservationIds: [first.pickup.reservationId, first.delivery.reservationId],
      key: `pair-2-${rid()}`,
      ttlMinutes: 10,
    });
    expect(replaced.releasedReservationIds.sort()).toEqual(
      [first.pickup.reservationId, first.delivery.reservationId].sort(),
    );
    expect(replaced.pickup.state).toBe("held");
    expect(replaced.delivery.state).toBe("held");
  });

  it("9. Worker loop (runOnceWithDb) settles pending refunds automatically", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });
    await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: inv.totalKopeks,
      key: `cap-${rid()}`,
    });
    const cancelled = await cancelOrder(db, f.dispatcher, {
      orderId: f.orderId,
      reason: "Customer requested cancellation",
      deferRefundSettlement: true,
      key: `cancel-${rid()}`,
    });
    expect(cancelled.refundSettlementState).toBe("pending");
    expect(cancelled.refundIds.length).toBe(1);

    const summary = await runOnceWithDb(db);
    expect(summary.refundsCompleted).toBeGreaterThanOrEqual(1);

    const [settled] = await db.select({ state: refunds.state })
      .from(refunds)
      .where(eq(refunds.id, cancelled.refundIds[0]));
    expect(settled?.state).toBe("completed");
  });

  it("11. Container scan lookup ignores unassigned historical assignments and resolves active assignment", async () => {
    const oldOrder = await seedFullOrder(db, { state: "pickup_assigned" });
    const newOrder = await seedFullOrder(db, { state: "pickup_assigned" });
    // Put both assignments in the same org on the same physical container code.
    const containerCode = `BAG-REUSED-${rid().slice(0, 8)}`;
    const [container] = await db.insert(containers).values({
      organizationId: newOrder.organizationId,
      code: containerCode,
    }).returning();
    const [oldSeal] = await db.insert(seals).values({
      organizationId: newOrder.organizationId,
      serialNumber: `SL-OLD-${rid().slice(0, 8)}`,
      state: "broken",
    }).returning();
    const [newSeal] = await db.insert(seals).values({
      organizationId: newOrder.organizationId,
      serialNumber: `SL-NEW-${rid().slice(0, 8)}`,
      state: "assigned",
    }).returning();

    // Historical unassigned row (older) referencing a different orderId — must be ignored.
    await db.insert(containerAssignments).values({
      organizationId: newOrder.organizationId,
      containerId: container.id,
      orderId: oldOrder.orderId,
      sealId: oldSeal.id,
      assignedAt: new Date("2026-11-01T10:00:00Z"),
      unassignedAt: new Date("2026-11-02T10:00:00Z"),
    });
    // Current active assignment for newOrder.
    await db.insert(containerAssignments).values({
      organizationId: newOrder.organizationId,
      containerId: container.id,
      orderId: newOrder.orderId,
      sealId: newSeal.id,
      assignedAt: new Date(Date.now() - 60_000),
      unassignedAt: null,
    });

    const clientEventId = rid();
    const baseEvent = {
      clientEventId,
      deviceId: newOrder.deviceId,
      scannedType: "container" as const,
      scannedId: containerCode,
      capturedAt: new Date().toISOString(),
      context: { stopId: newOrder.stopId },
    };
    const res = await syncScanEvents(db, newOrder.courier, [{
      ...baseEvent,
      payloadHash: canonicalScanHash(baseEvent),
    }]);
    expect(res.accepted).toEqual([clientEventId]);
    expect(res.rejected).toEqual([]);
  });

  it("12. GET /claims?state=invalid_state returns 400 VALIDATION_ERROR instead of 500", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const session = await loginAs(seed.organizationId, seed.phone, ["customer_support"]);

    const invalidRes = await app.inject({
      method: "GET",
      url: "/api/v1/claims?state=not_a_real_state",
      headers: { cookie: session.cookie },
    });
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.json().error.code).toBe("VALIDATION_ERROR");

    const validRes = await app.inject({
      method: "GET",
      url: "/api/v1/claims?state=opened",
      headers: { cookie: session.cookie },
    });
    expect(validRes.statusCode).toBe(200);
  });

  it("13. processPendingRefunds refuses to settle refund or post journal when payment_intent is disputed", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-disp-${rid()}` });
    await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: inv.totalKopeks,
      key: `cap-disp-${rid()}`,
    });
    const cancelled = await cancelOrder(db, f.dispatcher, {
      orderId: f.orderId,
      reason: "Cancel before dispute",
      deferRefundSettlement: true,
      key: `cancel-disp-${rid()}`,
    });
    expect(cancelled.refundIds.length).toBe(1);
    const refundId = cancelled.refundIds[0];

    // Transition the payment intent to `disputed` before the refund worker runs.
    await db.update(paymentIntents)
      .set({ state: "disputed" })
      .where(and(
        eq(paymentIntents.orderId, f.orderId),
        eq(paymentIntents.organizationId, f.organizationId),
      ));

    const processed = await processPendingRefunds(db, finance, { refundId });
    expect(processed.completed).toBe(0);
    expect(processed.errored).toBe(1);

    const [refundRow] = await db.select({ state: refunds.state })
      .from(refunds)
      .where(eq(refunds.id, refundId));
    expect(refundRow?.state).toBe("error");

    const journals = await db.select({ id: ledgerJournals.id })
      .from(ledgerJournals)
      .where(and(
        eq(ledgerJournals.organizationId, f.organizationId),
        eq(ledgerJournals.sourceType, "payment_refund"),
        eq(ledgerJournals.sourceId, refundId),
      ));
    expect(journals).toEqual([]);
  });

  it("14. disputePartnerLine locks partner row and reduces available payable balance for payouts", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const partner = await seedPartnerForOrder(db, f);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const [orderLine] = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId)).limit(1);

    const [accrual] = await db.insert(partnerServiceAccruals).values({
      organizationId: f.organizationId,
      partnerId: partner.partnerId,
      orderLineId: orderLine.id,
      contractId: partner.contractId,
      quantity: 1_000,
      amountKopeks: 50_000,
      status: "accrued",
      disputed: false,
    }).returning();
    const [pInv] = await db.insert(partnerInvoices).values({
      organizationId: f.organizationId,
      partnerId: partner.partnerId,
      number: `PINV-RT-${rid().slice(0, 8)}`,
      periodStart: new Date("2026-11-01T00:00:00Z"),
      periodEnd: new Date("2026-11-30T23:59:59Z"),
      totalKopeks: 50_000,
    }).returning();
    const [pLine] = await db.insert(partnerInvoiceLines).values({
      invoiceId: pInv.id,
      accrualId: accrual.id,
      amountKopeks: 50_000,
    }).returning();

    // Disputing the line acquires partners FOR UPDATE and marks the accrual disputed.
    const disputed = await disputePartnerLine(db, finance, {
      lineId: pLine.id,
      reason: "Weight discrepancy on partner invoice line",
      key: `disp-line-${rid()}`,
    });
    expect(disputed.state).toBe("open");

    // Subsequent payout for the disputed amount must be rejected as exceeding payable balance.
    await expect(createPartnerPayout(db, finance, {
      partnerId: partner.partnerId,
      amountKopeks: 50_000,
      key: `payout-after-disp-${rid()}`,
    })).rejects.toMatchObject({ code: "FINANCIAL_HOLD", message: "PAYOUT_EXCEEDS_PAYABLE" });
  });

  it("15. Finance queue pagination rejects non-UUID cursor.id with 400 VALIDATION_ERROR instead of 500", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const finance = makePrincipal(seed.organizationId, seed.userId, ["platform_finance"]);
    const badCursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-11-20T12:00:00.000000Z", id: "not-a-uuid" }),
      "utf8",
    ).toString("base64url");

    await expect(listPartnerPayouts(db, finance, { cursor: badCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INVALID_CURSOR" });
    await expect(listPartnerCreditNotes(db, finance, { cursor: badCursor }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INVALID_CURSOR" });
  });

  it("16. holdSlotPair validates quoteId ownership and tenant scoping", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const otherCustomerId = await seedUser(db, f.organizationId);
    const otherCustomer = makePrincipal(f.organizationId, otherCustomerId, ["customer"]);

    const [foreignOrg] = await db.insert(organizations).values({
      name: `Foreign Quote Org ${rid().slice(0, 8)}`,
    }).returning();
    const foreignCustomer = makePrincipal(foreignOrg.id, await seedUser(db, foreignOrg.id), ["customer"]);

    const seed = await seedWindow(db, { capacity: 4 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);

    // Nonexistent quoteId -> 404 NOT_FOUND.
    await expect(holdSlotPair(db, {
      principal: f.principal,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      quoteId: rid(),
      key: `hold-missing-quote-${rid()}`,
      ttlMinutes: 10,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Another customer in the same org trying to attach f.quoteId -> 404 NOT_FOUND.
    await expect(holdSlotPair(db, {
      principal: otherCustomer,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      quoteId: f.quoteId,
      key: `hold-other-cust-quote-${rid()}`,
      ttlMinutes: 10,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Foreign-org customer trying to attach f.quoteId on their own windows -> 404 NOT_FOUND.
    await expect(holdSlotPair(db, {
      principal: foreignCustomer,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      quoteId: f.quoteId,
      key: `hold-foreign-org-quote-${rid()}`,
      ttlMinutes: 10,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Owner customer holding with their own quoteId succeeds.
    const ownHold = await holdSlotPair(db, {
      principal: f.principal,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      quoteId: f.quoteId,
      key: `hold-own-quote-${rid()}`,
      ttlMinutes: 10,
    });
    expect(ownHold.pickup.state).toBe("held");
    expect(ownHold.delivery.state).toBe("held");
  });

  it("17. loadOrderView exposes buildingId and addressId only to owner customer and staff, never to partner or courier", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const partner = await seedPartnerForOrder(db, f);
    const [orderRow] = await db.select({ addressId: orders.addressId })
      .from(orders)
      .where(eq(orders.id, f.orderId))
      .limit(1);

    const customerView = await loadOrderView(db, f.principal, f.orderId);
    expect(customerView.buildingId).toBe(f.buildingId);
    expect(customerView.addressId).toBe(orderRow?.addressId);

    const staffView = await loadOrderView(db, f.dispatcher, f.orderId);
    expect(staffView.buildingId).toBe(f.buildingId);
    expect(staffView.addressId).toBe(orderRow?.addressId);

    const partnerView = await loadOrderView(db, partner.principal, f.orderId);
    expect("buildingId" in partnerView).toBe(false);
    expect("addressId" in partnerView).toBe(false);

    const courierView = await loadOrderView(db, f.courier, f.orderId);
    expect("buildingId" in courierView).toBe(false);
    expect("addressId" in courierView).toBe(false);
  });
});
