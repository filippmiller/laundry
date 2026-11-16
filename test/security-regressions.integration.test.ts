import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import {
  evidenceAssets, garments, orders, partnerInvoiceLines, routeStops,
} from "../src/db/schema.js";
import { hashRequest } from "../src/core/idempotency.js";
import type { Principal } from "../src/core/context.js";
import {
  makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow,
} from "./fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { createQuote } from "../src/services/quotes.js";
import { createOrder, scheduleOrder } from "../src/services/orders.js";
import { holdSlot } from "../src/domain/slot-reservation.js";
import { recordIntake } from "../src/services/intake.js";
import {
  receiveHandoff, recordQualityCheck, startInspection, startProcessing,
} from "../src/services/partner.js";
import { openClaim } from "../src/services/claims.js";
import { arriveStop, assignDelivery, recordDeliveryAttempt } from "../src/services/delivery.js";
import {
  capturePayment, createCustomerInvoice, createPartnerInvoice, disputePartnerLine, refundPayment,
} from "../src/services/finance.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const HOLD_TTL = new Date("2026-11-16T12:10:00Z");
const rid = () => randomUUID();
const bag = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const code = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("PR3 P0/P1 security regressions", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  async function orderFixture(capacity = 3) {
    const seed = await seedWindow(db, { capacity });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    return { ...seed, deliveryWindowId, catalog, principal };
  }

  async function placeOrder(f: Awaited<ReturnType<typeof orderFixture>>, key = rid()) {
    const quote = await createQuote(db, f.principal, {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `quote-${key}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    const order = await createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion, key: `order-${key}`,
    });
    return { quote, order };
  }

  async function holdsFor(
    f: Awaited<ReturnType<typeof orderFixture>>,
    principal: Principal,
    key: string,
    now = NOW,
  ) {
    const pickup = await holdSlot(db, {
      principal, windowId: f.windowId, key: `hold-pickup-${key}`, now, expiresAt: HOLD_TTL,
    });
    const delivery = await holdSlot(db, {
      principal, windowId: f.deliveryWindowId, key: `hold-delivery-${key}`, now, expiresAt: HOLD_TTL,
    });
    return { pickup, delivery };
  }

  async function login(organizationId: string, phone: string, roles: string[], partnerId?: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles, ...(partnerId ? { partnerId } : {}) },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
      userId: (response.json() as { userId: string }).userId,
    };
  }

  describe("LND3-P0-01 role-scoped reads", () => {
    it("a same-tenant customer cannot read or list another customer's order", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const foreign = await login(f.organizationId, `+7999${Math.floor(Math.random() * 1e7)}`, ["customer"]);

      const detail = await app.inject({
        method: "GET", url: `/api/v1/orders/${order.id}`, headers: { cookie: foreign.cookie },
      });
      expect(detail.statusCode).toBe(404);

      const list = await app.inject({ method: "GET", url: "/api/v1/orders", headers: { cookie: foreign.cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);

      const owner = await login(f.organizationId, f.phone, ["customer"]);
      const ownList = await app.inject({ method: "GET", url: "/api/v1/orders", headers: { cookie: owner.cookie } });
      expect(ownList.json()).toHaveLength(1);
    });

    it("customer and partner roles cannot call dispatch or finance read endpoints", async () => {
      const f = await orderFixture();
      const customer = await login(f.organizationId, f.phone, ["customer"]);
      for (const url of [
        "/api/v1/dispatch/pickup-queue",
        "/api/v1/dispatch/capacity-reconciliation",
        "/api/v1/finance/reconciliation",
        "/api/v1/finance/fiscal-receipts",
      ]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie: customer.cookie } });
        expect(response.statusCode, url).toBe(403);
      }
    });

    it("a partner sees only assigned orders and no terms/quote fields in the detail projection", async () => {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const partner = await seedPartnerForOrder(db, f);
      const loginPartner = await login(f.organizationId, `+7999${Math.floor(Math.random() * 1e7)}`, ["laundry_operator"], partner.partnerId);

      const detail = await app.inject({
        method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: loginPartner.cookie },
      });
      expect(detail.statusCode).toBe(200);
      const body = detail.json() as Record<string, unknown>;
      expect(body.id).toBe(f.orderId);
      expect(body.acceptedQuoteHash).toBeUndefined();
      expect(body.addressId).toBeUndefined();
      expect(body.quoteId).toBeUndefined();
    });
  });

  describe("LND3-P0-02 partner custody ownership", () => {
    it("an unassigned partner cannot claim custody by receiving a manifest", async () => {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const seal = await seedSeal(db, f.organizationId);
      const intake = await recordIntake(db, f.courier, {
        orderId: f.orderId, mode: "economy_bag",
        bags: [{ containerCode: bag("BAG-UNASSIGNED"), sealSerial: seal.serial, weightGrams: 1_000 }],
        customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
      });
      const partner = await seedPartnerForOrder(db, f);
      // Detach the assignment to model a partner that was never granted custody.
      await db.update(orders).set({ assignedPartnerId: null }).where(eq(orders.id, f.orderId));
      await expect(receiveHandoff(db, partner.principal, {
        orderId: f.orderId, manifestId: intake.manifestId,
        actual: [{ containerCode: bag("BAG-UNASSIGNED"), sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `receipt-${rid()}`,
      })).rejects.toThrow("NOT_FOUND");
    });

    it("a different partner cannot inspect or process an assigned order", async () => {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      await seedPartnerForOrder(db, f);
      const foreignPrincipal = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["laundry_operator"], {
        partnerId: rid(),
      });
      await expect(startInspection(db, foreignPrincipal, { orderId: f.orderId, key: `inspect-${rid()}` }))
        .rejects.toThrow("NOT_FOUND");
      await expect(startProcessing(db, foreignPrincipal, { orderId: f.orderId, processType: "wash", key: `batch-${rid()}` }))
        .rejects.toThrow("NOT_FOUND");
    });

    it("a partner finance user cannot dispute another partner's invoice line", async () => {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const seal = await seedSeal(db, f.organizationId);
      const partner = await seedPartnerForOrder(db, f);
      const containerCode = bag("BAG-DISPUTE");
      const intake = await recordIntake(db, f.courier, {
        orderId: f.orderId, mode: "economy_bag",
        bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
        customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
      });
      await receiveHandoff(db, partner.principal, {
        orderId: f.orderId, manifestId: intake.manifestId,
        actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `receipt-${rid()}`,
      });
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const invoice = await createPartnerInvoice(db, finance, {
        partnerId: partner.partnerId,
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2027-01-01T00:00:00Z"),
        key: `pinv-${rid()}`,
      });
      const [line] = await db.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.invoiceId, invoice.invoiceId));
      expect(line).toBeDefined();

      const foreignFinance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["partner_finance"], {
        partnerId: rid(),
      });
      await expect(disputePartnerLine(db, foreignFinance, { lineId: line.id, reason: "не наша услуга", key: `dispute-${rid()}` }))
        .rejects.toThrow("NOT_FOUND");
      const ownFinance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["partner_finance"], {
        partnerId: partner.partnerId,
      });
      await expect(disputePartnerLine(db, ownFinance, { lineId: line.id, reason: "неверный объём", key: `dispute-${rid()}` }))
        .resolves.toMatchObject({ state: "open" });
    });
  });

  describe("LND3-P0-03 idempotency key ownership", () => {
    it("rejects a key replayed by a different principal in the same tenant", async () => {
      const f = await orderFixture();
      const otherUserId = await seedUser(db, f.organizationId);
      await seedAddress(db, f.organizationId, otherUserId, f.buildingId);
      const other = makePrincipal(f.organizationId, otherUserId, ["customer"]);
      const input = {
        buildingId: f.buildingId,
        pickupWindowId: f.windowId,
        deliveryWindowId: f.deliveryWindowId,
        tariffVersionId: f.catalog.tariffVersionId,
        key: `shared-key-${rid()}`,
        lines: [{ serviceId: f.catalog.serviceId, tier: "economy" as const, quantity: 1_000, unit: "gram" as const }],
      };
      await createQuote(db, f.principal, input);
      await expect(createQuote(db, other, input)).rejects.toThrow("IDEMPOTENCY_OWNER_MISMATCH");
    });

    it("re-authorizes the target on replay, so a reassigned order is not returned", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const holds = await holdsFor(f, f.principal, rid());
      const key = `schedule-${rid()}`;
      await scheduleOrder(db, f.principal, {
        orderId: order.id, pickupReservationId: holds.pickup.reservationId,
        deliveryReservationId: holds.delivery.reservationId, key, now: NOW,
      });
      const otherUserId = await seedUser(db, f.organizationId);
      await db.update(orders).set({ customerId: otherUserId }).where(eq(orders.id, order.id));
      await expect(scheduleOrder(db, f.principal, {
        orderId: order.id, pickupReservationId: holds.pickup.reservationId,
        deliveryReservationId: holds.delivery.reservationId, key, now: NOW,
      })).rejects.toThrow("NOT_FOUND");
    });

    it("rejects a claim key replayed by another customer", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const key = `claim-${rid()}`;
      await openClaim(db, f.principal, { orderId: order.id, claimType: "damage", description: "пятно", key });
      const otherUserId = await seedUser(db, f.organizationId);
      const other = makePrincipal(f.organizationId, otherUserId, ["customer"]);
      await expect(openClaim(db, other, { orderId: order.id, claimType: "damage", description: "пятно", key }))
        .rejects.toThrow("IDEMPOTENCY_OWNER_MISMATCH");
    });
  });

  describe("LND3-P0-04 financial concurrency", () => {
    async function paidOrder() {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const invoice = await createCustomerInvoice(db, finance, { orderId: order.id, key: `invoice-${rid()}` });
      const capture = await capturePayment(db, finance, {
        orderId: order.id, amountKopeks: invoice.totalKopeks, key: `capture-${rid()}`,
      });
      return { f, order, finance, invoice, capture };
    }

    it("a second capture under another key cannot double-charge the order", async () => {
      const paid = await paidOrder();
      await expect(capturePayment(db, paid.finance, {
        orderId: paid.order.id, amountKopeks: paid.invoice.totalKopeks, key: `capture-again-${rid()}`,
      })).rejects.toThrow("ORDER_ALREADY_CAPTURED");
    });

    it("two concurrent captures under distinct keys produce exactly one capture", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const invoice = await createCustomerInvoice(db, finance, { orderId: order.id, key: `invoice-${rid()}` });
      const results = await Promise.allSettled([
        capturePayment(db, finance, { orderId: order.id, amountKopeks: invoice.totalKopeks, key: `cap-a-${rid()}` }),
        capturePayment(db, finance, { orderId: order.id, amountKopeks: invoice.totalKopeks, key: `cap-b-${rid()}` }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    });

    it("two concurrent full refunds cannot refund more than captured", async () => {
      const paid = await paidOrder();
      const amount = paid.invoice.totalKopeks;
      const results = await Promise.allSettled([
        refundPayment(db, paid.finance, {
          paymentIntentId: paid.capture.paymentIntentId, amountKopeks: amount, reason: "дубль 1", key: `refund-a-${rid()}`,
        }),
        refundPayment(db, paid.finance, {
          paymentIntentId: paid.capture.paymentIntentId, amountKopeks: amount, reason: "дубль 2", key: `refund-b-${rid()}`,
        }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const refunded = results
        .flatMap(result => (result.status === "fulfilled" ? [result.value.amountKopeks] : []))
        .reduce((total, amount) => total + amount, 0);
      expect(refunded).toBe(amount);
    });
  });

  describe("LND3-P0-05 booking integrity", () => {
    it("rejects scheduling with zero capacity reservations", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      await expect(scheduleOrder(db, f.principal, { orderId: order.id, key: `schedule-${rid()}`, now: NOW }))
        .rejects.toThrow("BOTH_RESERVATIONS_REQUIRED");
    });

    it("rejects another customer's hold (same tenant capacity hijack)", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const otherUserId = await seedUser(db, f.organizationId);
      await seedAddress(db, f.organizationId, otherUserId, f.buildingId);
      const other = makePrincipal(f.organizationId, otherUserId, ["customer"]);
      const foreignHolds = await holdsFor(f, other, rid());
      await expect(scheduleOrder(db, f.principal, {
        orderId: order.id, pickupReservationId: foreignHolds.pickup.reservationId,
        deliveryReservationId: foreignHolds.delivery.reservationId, key: `schedule-${rid()}`, now: NOW,
      })).rejects.toThrow("NOT_FOUND");
    });

    it("rejects a delivery hold supplied as the pickup leg", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const holds = await holdsFor(f, f.principal, rid());
      await expect(scheduleOrder(db, f.principal, {
        orderId: order.id, pickupReservationId: holds.delivery.reservationId,
        deliveryReservationId: holds.pickup.reservationId, key: `schedule-${rid()}`, now: NOW,
      })).rejects.toThrow("NOT_FOUND");
    });

    it("rejects an expired hold", async () => {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const holds = await holdsFor(f, f.principal, rid());
      await expect(scheduleOrder(db, f.principal, {
        orderId: order.id, pickupReservationId: holds.pickup.reservationId,
        deliveryReservationId: holds.delivery.reservationId, key: `schedule-${rid()}`,
        now: new Date("2026-11-16T12:20:00Z"),
      })).rejects.toThrow("RESERVATION_NOT_CONFIRMABLE");
    });
  });

  describe("LND3-P0-06 claim object binding", () => {
    async function orderWithItems() {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const seal = await seedSeal(db, f.organizationId);
      const intake = await recordIntake(db, f.courier, {
        orderId: f.orderId, mode: "protected_items",
        bags: [{ containerCode: bag("BAG-CLAIM"), sealSerial: seal.serial, weightGrams: 1_000 }],
        items: [
          { itemCode: code("G1"), category: "shirt", description: "рубашка" },
          { itemCode: code("G2"), category: "dress", description: "платье" },
        ],
        customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
      });
      return { ...f, garmentIds: intake.garments.map(garment => garment.id) };
    }

    it("rejects a garment that belongs to another order", async () => {
      const own = await orderWithItems();
      const foreign = await orderWithItems();
      await expect(openClaim(db, own.principal, {
        orderId: own.orderId, claimType: "damage", description: "чужое изделие",
        garmentIds: [foreign.garmentIds[0]], key: `claim-${rid()}`,
      })).rejects.toThrow("NOT_FOUND");
      const [garment] = await db.select().from(garments).where(eq(garments.id, foreign.garmentIds[0]));
      expect(garment.orderId).toBe(foreign.orderId);
    });

    it("rejects evidence owned by another order and accepts the order's own evidence", async () => {
      const own = await orderWithItems();
      const foreign = await orderWithItems();
      const [foreignAsset] = await db.insert(evidenceAssets).values({
        organizationId: foreign.organizationId,
        ownerType: "order",
        ownerId: foreign.orderId,
        objectKey: `evidence/${rid()}.jpg`,
        sha256: "b".repeat(64),
        purpose: "intake_condition",
        status: "verified",
      }).returning();
      await expect(openClaim(db, own.principal, {
        orderId: own.orderId, claimType: "damage", description: "чужое фото",
        evidenceIds: [foreignAsset.id], key: `claim-${rid()}`,
      })).rejects.toThrow("NOT_FOUND");

      const [ownAsset] = await db.insert(evidenceAssets).values({
        organizationId: own.organizationId,
        ownerType: "order",
        ownerId: own.orderId,
        objectKey: `evidence/${rid()}.jpg`,
        sha256: "c".repeat(64),
        purpose: "intake_condition",
        status: "verified",
      }).returning();
      await expect(openClaim(db, own.principal, {
        orderId: own.orderId, claimType: "damage", description: "своё фото",
        garmentIds: [own.garmentIds[0]], evidenceIds: [ownAsset.id], key: `claim-${rid()}`,
      })).resolves.toMatchObject({ state: "opened" });
    });
  });

  describe("LND3-P0-07 payment webhook authentication", () => {
    function sign(body: { eventId: string; eventType: string; payload: Record<string, unknown> }, provider = "fake") {
      const canonical = `${provider}:${body.eventId}:${body.eventType}:${hashRequest(body.payload)}`;
      return createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET!).update(canonical).digest("hex");
    }

    async function paidIntent() {
      const f = await orderFixture();
      const { order } = await placeOrder(f);
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const invoice = await createCustomerInvoice(db, finance, { orderId: order.id, key: `invoice-${rid()}` });
      const capture = await capturePayment(db, finance, {
        orderId: order.id, amountKopeks: invoice.totalKopeks, key: `capture-${rid()}`,
      });
      return { f, order, capture };
    }

    it("rejects a webhook without a valid provider signature", async () => {
      const paid = await paidIntent();
      const body = {
        eventId: `evt-${rid()}`, eventType: "captured",
        payload: { organizationId: paid.f.organizationId, paymentIntentId: paid.capture.paymentIntentId },
      };
      const unsigned = await app.inject({ method: "POST", url: "/api/v1/webhooks/payments/fake", payload: body });
      expect(unsigned.statusCode).toBe(401);
      const forged = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/fake", payload: body,
        headers: { "x-provider-signature": "sha256=" + "0".repeat(64) },
      });
      expect(forged.statusCode).toBe(401);
    });

    it("records a signed event once and rejects an unsupported provider or a foreign tenant claim", async () => {
      const paid = await paidIntent();
      const body = {
        eventId: `evt-${rid()}`, eventType: "captured",
        payload: { organizationId: paid.f.organizationId, paymentIntentId: paid.capture.paymentIntentId },
      };
      const first = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/fake", payload: body,
        headers: { "x-provider-signature": sign(body) },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "recorded" });
      const replay = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/fake", payload: body,
        headers: { "x-provider-signature": sign(body) },
      });
      expect(replay.json()).toMatchObject({ status: "duplicate" });

      const otherTenantBody = {
        eventId: `evt-${rid()}`, eventType: "captured",
        payload: { organizationId: rid(), paymentIntentId: paid.capture.paymentIntentId },
      };
      const mismatch = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/fake", payload: otherTenantBody,
        headers: { "x-provider-signature": sign(otherTenantBody) },
      });
      expect(mismatch.statusCode).toBe(400);

      const unsupported = await app.inject({
        method: "POST", url: "/api/v1/webhooks/payments/acme", payload: body,
        headers: { "x-provider-signature": sign(body, "acme") },
      });
      expect(unsupported.statusCode).toBe(503);
    });
  });

  describe("LND3-P1-01 exact-set delivery", () => {
    async function deliveredOrder() {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const seal = await seedSeal(db, f.organizationId);
      const partner = await seedPartnerForOrder(db, f);
      const containerCode = bag("BAG-EXACT");
      const intake = await recordIntake(db, f.courier, {
        orderId: f.orderId, mode: "protected_items",
        bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
        items: [
          { itemCode: code("G1"), category: "shirt", description: "рубашка" },
          { itemCode: code("G2"), category: "dress", description: "платье" },
        ],
        customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
      });
      await receiveHandoff(db, partner.principal, {
        orderId: f.orderId, manifestId: intake.manifestId,
        actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `receipt-${rid()}`,
      });
      await startInspection(db, partner.principal, { orderId: f.orderId, key: `inspect-${rid()}` });
      await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `batch-${rid()}` });
      const garmentIds = intake.garments.map(garment => garment.id);
      await recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: garmentIds.map(garmentId => ({ garmentId, passed: true })),
        key: `qc-${rid()}`,
      });
      const assigned = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: `deliver-${rid()}` });
      await arriveStop(db, f.courier, { stopId: assigned.stopId, key: `arrive-${rid()}` });
      return { ...f, garmentIds, stopId: assigned.stopId };
    }

    it("rejects duplicate garment ids instead of counting them as a full set", async () => {
      const f = await deliveredOrder();
      await expect(recordDeliveryAttempt(db, f.courier, {
        stopId: f.stopId, outcome: "delivered",
        deliveredGarmentIds: [f.garmentIds[0], f.garmentIds[0]],
        recipientProof: { method: "code", value: "1234" }, key: `attempt-${rid()}`,
      })).rejects.toThrow("DUPLICATE_GARMENT_ID");
    });

    it("rejects an incomplete set marked as fully delivered", async () => {
      const f = await deliveredOrder();
      await expect(recordDeliveryAttempt(db, f.courier, {
        stopId: f.stopId, outcome: "delivered",
        deliveredGarmentIds: [f.garmentIds[0]],
        recipientProof: { method: "code", value: "1234" }, key: `attempt-${rid()}`,
      })).rejects.toThrow("DELIVERY_SET_MISMATCH");
      const attempt = await recordDeliveryAttempt(db, f.courier, {
        stopId: f.stopId, outcome: "delivered",
        deliveredGarmentIds: [...f.garmentIds],
        recipientProof: { method: "code", value: "1234" }, key: `attempt-${rid()}`,
      });
      expect(attempt.state).toBe("delivered");
    });

    it("completes an Economy bag order at bag level and creates a recovery stop on partial", async () => {
      const f = await seedFullOrder(db, { state: "pickup_assigned" });
      const seal = await seedSeal(db, f.organizationId);
      const partner = await seedPartnerForOrder(db, f);
      const containerCode = bag("BAG-ECONOMY");
      const intake = await recordIntake(db, f.courier, {
        orderId: f.orderId, mode: "economy_bag",
        bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
        customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
      });
      await receiveHandoff(db, partner.principal, {
        orderId: f.orderId, manifestId: intake.manifestId,
        actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `receipt-${rid()}`,
      });
      await startInspection(db, partner.principal, { orderId: f.orderId, key: `inspect-${rid()}` });
      await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `batch-${rid()}` });
      await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], key: `qc-${rid()}` });
      const assigned = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: `deliver-${rid()}` });
      await arriveStop(db, f.courier, { stopId: assigned.stopId, key: `arrive-${rid()}` });

      const partial = await recordDeliveryAttempt(db, f.courier, {
        stopId: assigned.stopId, outcome: "partial",
        recipientProof: { method: "code", value: "9999" }, reason: "часть не выдана", key: `attempt-${rid()}`,
      });
      expect(partial.recoveryStopId).toBeTruthy();
      const [recovery] = await db.select().from(routeStops).where(and(
        eq(routeStops.id, partial.recoveryStopId!),
        eq(routeStops.orderId, f.orderId),
      ));
      expect(recovery.state).toBe("pending");
      expect(recovery.kind).toBe("delivery");

      await arriveStop(db, f.courier, { stopId: recovery.id, key: `arrive-recovery-${rid()}` });
      const delivered = await recordDeliveryAttempt(db, f.courier, {
        stopId: recovery.id, outcome: "delivered",
        recipientProof: { method: "code", value: "9999" }, key: `attempt-${rid()}`,
      });
      expect(delivered.state).toBe("delivered");
    });
  });
});
