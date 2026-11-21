import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import {
  customerInvoices, memberships, orderLines, orders, organizations, otpChallenges, outboxEvents, partnerServiceAccruals,
  partners, serviceWindows, services, tariffPlans, tariffVersions, users,
} from "../src/db/schema.js";
import { hashRequest } from "../src/core/idempotency.js";
import { holdSlot } from "../src/domain/slot-reservation.js";
import { activeTariff, listServices } from "../src/services/catalog.js";
import { customerFinance } from "../src/services/customer-finance.js";
import { createPartnerInvoice } from "../src/services/finance.js";
import { itemMix } from "../src/services/item-mix.js";
import { requestOtpChallenge, verifyOtpChallenge } from "../src/services/otp.js";
import { trackOrder } from "../src/services/customer.js";
import { makePrincipal, seedCatalog, seedUser, seedWindow } from "./fixtures.js";
import { seedFullOrder, seedPartner } from "./operations-fixtures.js";

/**
 * Regression cover for the defects found in the code audit of 2026-11-19.
 *
 * Every case in this file is a bug that shipped and was fixed: without the test the fix can be
 * silently undone by the next refactor, and the bug comes back with a customer complaint instead
 * of a red build.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("audit regressions", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(() => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  describe("idempotency fingerprints", () => {
    it("tells two timestamps apart instead of hashing them identically", () => {
      // A `Date` has no own enumerable keys, so a plain stable stringify turned every timestamp
      // into `{}`. Two bodies that differed only in a date hashed the same and the idempotency
      // spine could no longer tell a retry from a changed request.
      const first = hashRequest({ at: new Date("2026-01-01T00:00:00.000Z") });
      const second = hashRequest({ at: new Date("2026-01-02T00:00:00.000Z") });
      expect(first).not.toBe(second);
      expect(hashRequest({ at: new Date("2026-01-01T00:00:00.000Z") })).toBe(first);
    });

    it("ignores the order of the keys", () => {
      expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    });
  });

  describe("slot holds", () => {
    it("replays the same hold instead of reporting a payload conflict", async () => {
      const seed = await seedWindow(db, { capacity: 3 });
      const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
      const now = new Date("2026-11-16T12:00:00.000Z");

      const first = await holdSlot(db, {
        principal, windowId: seed.windowId, key: "replay-key", ttlMinutes: 10, now,
      });
      expect(first.replayed).toBe(false);

      // The very same request, sent again: the fingerprint has to stay stable, otherwise the retry
      // of a hold is answered with 409 IDEMPOTENCY_PAYLOAD_CONFLICT and the customer loses the slot.
      const second = await holdSlot(db, {
        principal, windowId: seed.windowId, key: "replay-key", ttlMinutes: 10, now,
      });
      expect(second.replayed).toBe(true);
      expect(second.reservationId).toBe(first.reservationId);

      // …and the capacity counter may only have been spent once.
      const [window] = await db.select({ reserved: serviceWindows.reservedOrders })
        .from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
      expect(window?.reserved).toBe(1);
    });

    it("still refuses a hold whose payload really changed", async () => {
      const seed = await seedWindow(db, { capacity: 3 });
      const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
      const now = new Date("2026-11-16T12:00:00.000Z");

      await holdSlot(db, { principal, windowId: seed.windowId, key: "conflict-key", ttlMinutes: 10, now });
      await expect(holdSlot(db, {
        principal, windowId: seed.windowId, key: "conflict-key", ttlMinutes: 20, now,
      })).rejects.toThrow("IDEMPOTENCY_PAYLOAD_CONFLICT");
    });
  });

  describe("catalogue", () => {
    it("serves the newest tariff version that has already taken effect", async () => {
      const seed = await seedWindow(db);
      await seedCatalog(db, seed.organizationId);
      const principal = makePrincipal(seed.organizationId, seed.userId, ["dispatcher"]);

      const [existing] = await db.select({ planId: tariffVersions.planId })
        .from(tariffVersions)
        .innerJoin(tariffPlans, eq(tariffPlans.id, tariffVersions.planId))
        .where(eq(tariffPlans.organizationId, seed.organizationId))
        .limit(1);
      expect(existing).toBeTruthy();

      const [newer] = await db.insert(tariffVersions).values({
        planId: existing!.planId,
        version: "v2-price-rise",
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
        termsVersion: "offer-2026-11",
        published: true,
      }).returning();
      expect(newer).toBeTruthy();

      // Ordering ascending picked the oldest still-published version, so a price increase never
      // reached a quote as long as the previous version had not been closed.
      const active = await activeTariff(db, principal, undefined, new Date("2026-11-16T12:00:00.000Z"));
      expect(active.id).toBe(newer.id);
      expect(active.version).toBe("v2-price-rise");
    });

    it("does not offer a service that was withdrawn from the catalogue", async () => {
      const seed = await seedWindow(db);
      const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
      await db.insert(services).values({
        organizationId: seed.organizationId, code: "ironing-off", name: "Глажка (выведена)", active: false,
      });
      const listed = await listServices(db, principal);
      expect(listed.some(service => service.code === "ironing-off")).toBe(false);
    });
  });

  describe("item mix", () => {
    it("refuses a partner principal without a partner binding", async () => {
      const seed = await seedWindow(db);
      // Every partner filter in the query is dropped when the id is null, so a partner principal
      // without a binding fell through to the tenant-wide query and saw the whole book.
      const principal = makePrincipal(seed.organizationId, seed.userId, ["laundry_operator"]);
      await expect(itemMix(db, principal)).rejects.toThrow("FORBIDDEN");
    });
  });

  describe("customer money view", () => {    it("does not turn a voided invoice into a debt", async () => {
      const order = await seedFullOrder(db);
      const principal = makePrincipal(order.organizationId, order.userId, ["customer"]);

      await db.insert(customerInvoices).values({
        organizationId: order.organizationId,
        orderId: order.orderId,
        number: "INV-VOIDED",
        totalKopeks: 5000,
        state: "cancelled",
      });

      const ledger = await customerFinance(db, principal);
      const row = ledger.orders.find(entry => entry.orderId === order.orderId);
      expect(row?.invoiceNumber).toBeNull();
      expect(row?.chargedKopeks).toBe(0);
      expect(ledger.totals.outstandingKopeks).toBe(0);
    });
  });

  describe("partner invoicing", () => {
    it("bills only the accruals that are not contested and bills them once", async () => {
      const order = await seedFullOrder(db);
      const partner = await seedPartner(db, order.organizationId);
      const finance = makePrincipal(order.organizationId, await seedUser(db, order.organizationId), ["platform_finance"]);

      const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, order.orderId)).limit(1);
      expect(line).toBeTruthy();

      await db.insert(partnerServiceAccruals).values([
        {
          organizationId: order.organizationId, partnerId: partner.partnerId, orderLineId: line!.id,
          contractId: partner.contractId, quantity: 1000, amountKopeks: 6000,
          status: "estimated", disputed: false, createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          organizationId: order.organizationId, partnerId: partner.partnerId, orderLineId: line!.id,
          contractId: partner.contractId, quantity: 1000, amountKopeks: 7000,
          status: "estimated", disputed: true, createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      ]);

      const invoice = await createPartnerInvoice(db, finance, {
        partnerId: partner.partnerId,
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2026-12-31T23:59:59.000Z"),
        key: "pinv-first",
      });
      // The contested accrual is money the platform does not owe yet.
      expect(invoice.totalKopeks).toBe(6000);
      expect(invoice.lineCount).toBe(1);

      // A second invoice for the same period must not bill the same work twice.
      const second = await createPartnerInvoice(db, finance, {
        partnerId: partner.partnerId,
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2026-12-31T23:59:59.000Z"),
        key: "pinv-second",
      });
      expect(second.totalKopeks).toBe(0);
      expect(second.lineCount).toBe(0);
    });

    it("refuses to invoice a partner of another tenant", async () => {
      const order = await seedFullOrder(db);
      const finance = makePrincipal(order.organizationId, await seedUser(db, order.organizationId), ["platform_finance"]);
      const foreignSeed = await seedWindow(db);
      const [foreignPartner] = await db.insert(partners).values({
        organizationId: foreignSeed.organizationId, name: "Чужая прачечка",
      }).returning();

      await expect(createPartnerInvoice(db, finance, {
        partnerId: foreignPartner!.id,
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2026-12-31T23:59:59.000Z"),
        key: "pinv-foreign",
      })).rejects.toThrow("NOT_FOUND");
    });
  });

  describe("the public tracker", () => {
    it("reports the last state change, not the creation time", async () => {
      const order = await seedFullOrder(db);
      const publicNumber = `TRK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await db.update(orders).set({ publicNumber }).where(eq(orders.id, order.orderId));

      const moved = new Date("2030-05-05T10:00:00.000Z");
      await db.insert(outboxEvents).values({
        organizationId: order.organizationId,
        aggregateType: "order",
        aggregateId: order.orderId,
        eventType: "order.test_move",
        payloadJson: {},
        createdAt: moved,
      });

      const tracked = await trackOrder(db, order.organizationId, {
        publicNumber, phone: order.phone,
      });
      expect(new Date(tracked.updatedAt).toISOString()).toBe(moved.toISOString());
    });
  });

  describe("the phone OTP", () => {
    it("consumes the code even when the membership is suspended", async () => {
      const previousFlag = process.env.ALLOW_FAKE_OTP;
      process.env.ALLOW_FAKE_OTP = "true";
      try {
        const [org] = await db.insert(organizations).values({ name: "OTP tenant" }).returning();
        const phone = `+7999${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
        const [user] = await db.insert(users).values({ phone }).returning();
        await db.insert(memberships).values({
          organizationId: org!.id, userId: user!.id, state: "suspended",
        });

        const challenge = await requestOtpChallenge(db, { organizationId: org!.id, phone });
        await expect(verifyOtpChallenge(db, {
          organizationId: org!.id, phone, code: challenge.devCode,
        })).rejects.toThrow("FORBIDDEN");

        // The refusal is an outcome, not an exception: the transaction commits, so the challenge
        // is consumed. A throw inside the transaction rolled the consumption back and left the
        // code usable until it expired on its own.
        const [stored] = await db.select().from(otpChallenges)
          .where(eq(otpChallenges.phone, phone)).limit(1);
        expect(stored?.consumedAt).toBeTruthy();
      } finally {
        if (previousFlag === undefined) delete process.env.ALLOW_FAKE_OTP;
        else process.env.ALLOW_FAKE_OTP = previousFlag;
      }
    });
  });
});
