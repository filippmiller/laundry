import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import {
  containers, courierShifts, documentVersions, evidenceAssets, evidenceLegalHolds,
  garmentEvidence, orders, outboxEvents, serviceWindows, slotReservations, users,
} from "../src/db/schema.js";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "./fixtures.js";
import { seedEvidence, seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { createQuote } from "../src/services/quotes.js";
import { cancelOrder, createOrder, loadOrderView, rescheduleOrder, scheduleOrder } from "../src/services/orders.js";
import { holdSlot, reconcileCapacity } from "../src/domain/slot-reservation.js";
import { recordIntake } from "../src/services/intake.js";
import {
  receiveHandoff, returnUnprocessedOrder, startInspection,
} from "../src/services/partner.js";
import { assignPickup } from "../src/services/delivery.js";
import { setMembershipState } from "../src/services/admin.js";
import { listGarmentEvidence, registerEvidence } from "../src/services/workspace.js";

const rid = () => randomUUID();
const NOW = new Date("2026-11-16T12:00:00.000Z");
const HOLD_TTL = new Date("2026-11-16T12:10:00.000Z");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Track 2B: Orders, Intake, Capacity, Optimistic Locks, Tenant Isolation & Security", () => {
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

  it("lnd-6tf: two different organizations can create containers with the same code, while duplicate code in same org is rejected", async () => {
    const orgA = await seedFullOrder(db, { state: "pickup_assigned" });
    const orgB = await seedFullOrder(db, { state: "pickup_assigned" });
    const sharedCode = `BAG-SHARED-${rid().slice(0, 8)}`;

    const [cA] = await db.insert(containers).values({
      organizationId: orgA.organizationId,
      code: sharedCode,
    }).returning();
    const [cB] = await db.insert(containers).values({
      organizationId: orgB.organizationId,
      code: sharedCode,
    }).returning();
    expect(cA.code).toBe(sharedCode);
    expect(cB.code).toBe(sharedCode);
    expect(cA.organizationId).not.toBe(cB.organizationId);

    // Duplicate code in the same organization is rejected by containers_org_code_unique.
    await expect(db.insert(containers).values({
      organizationId: orgA.organizationId,
      code: sharedCode,
    })).rejects.toThrow();

    // Intake in both orgs succeeds using the same physical container code.
    const sealA = await seedSeal(db, orgA.organizationId);
    const sealB = await seedSeal(db, orgB.organizationId);
    const intakeA = await recordIntake(db, orgA.courier, {
      orderId: orgA.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: sharedCode, sealSerial: sealA.serial, weightGrams: 1_200 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-a-${rid()}`,
    });
    const intakeB = await recordIntake(db, orgB.courier, {
      orderId: orgB.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: sharedCode, sealSerial: sealB.serial, weightGrams: 1_500 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-b-${rid()}`,
    });
    expect(intakeA.state).toBe("picked_up");
    expect(intakeB.state).toBe("picked_up");
  });

  it("lnd-kje: intake persists verified garment_evidence links and exposes them respecting ABAC", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const partner = await seedPartnerForOrder(db, f);
    const seal = await seedSeal(db, f.organizationId);
    const evId = await seedEvidence(db, f.organizationId, f.orderId);

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-EV-${rid().slice(0, 8)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [{
        itemCode: `ITEM-EV-${rid().slice(0, 8)}`,
        category: "рубашка",
        description: "Белая рубашка",
        declaredValueKopeks: 450_000,
        evidenceAssetIds: [evId],
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-ev-${rid()}`,
    });

    const garmentId = intake.garments[0].id;
    const links = await db.select().from(garmentEvidence).where(eq(garmentEvidence.garmentId, garmentId));
    expect(links).toHaveLength(1);
    expect(links[0].evidenceAssetId).toBe(evId);

    // Owner customer and assigned partner see evidenceAssetIds on order view and via listGarmentEvidence.
    const customerView = await loadOrderView(db, f.principal, f.orderId);
    expect((customerView.garments[0] as { evidenceAssetIds?: string[] }).evidenceAssetIds).toEqual([evId]);

    const partnerView = await loadOrderView(db, partner.principal, f.orderId);
    expect((partnerView.garments[0] as { evidenceAssetIds?: string[] }).evidenceAssetIds).toEqual([evId]);

    // Courier does not see evidenceAssetIds on order view.
    const courierView = await loadOrderView(db, f.courier, f.orderId);
    expect((courierView.garments[0] as { evidenceAssetIds?: string[] }).evidenceAssetIds).toBeUndefined();

    const listed = await listGarmentEvidence(db, f.principal, garmentId);
    expect(listed.map(row => row.id)).toEqual([evId]);
    expect((listed[0] as Record<string, unknown>).objectKey).toBeUndefined();

    // Foreign customer is denied garment evidence listing.
    const foreignCustomer = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(listGarmentEvidence(db, foreignCustomer, garmentId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lnd-mw8: economy-only order rejects protected_items/mixed intake while protected order accepts it", async () => {
    const econ = await seedFullOrder(db, { state: "pickup_assigned", tier: "economy" });
    const econSeal = await seedSeal(db, econ.organizationId);

    await expect(recordIntake(db, econ.courier, {
      orderId: econ.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-ECON-${rid().slice(0, 8)}`, sealSerial: econSeal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-${rid().slice(0, 6)}`, category: "shirt", description: "рубашка" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-econ-prot-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_EXCEEDS_QUOTED_TIER" });

    await expect(recordIntake(db, econ.courier, {
      orderId: econ.orderId,
      mode: "mixed",
      bags: [{ containerCode: `BAG-ECON-M-${rid().slice(0, 8)}`, sealSerial: econSeal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-M-${rid().slice(0, 6)}`, category: "shirt", description: "рубашка" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-econ-mix-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_EXCEEDS_QUOTED_TIER" });

    // Protected quote accepts protected_items intake.
    const prot = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const protSeal = await seedSeal(db, prot.organizationId);
    const accepted = await recordIntake(db, prot.courier, {
      orderId: prot.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-PROT-${rid().slice(0, 8)}`, sealSerial: protSeal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-P-${rid().slice(0, 6)}`, category: "shirt", description: "рубашка" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-prot-ok-${rid()}`,
    });
    expect(accepted.state).toBe("picked_up");
    expect(accepted.garments).toHaveLength(1);
  });

  it("lnd-7c3: optimistic lock conflict in scheduleOrder, cancelOrder, and rescheduleOrder throws CONFLICT_VERSION with zero stray events", async () => {
    /**
     * Simulates a concurrent writer bumping `orders.version` between `loadOrder` and
     * `UPDATE orders ... WHERE version = order.version` inside the service transaction.
     */
    function withStaleOrderVersion(orderId: string): Db {
      let bumped = false;
      const wrapTx = (tx: Db): Db => new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return (fn: (inner: Db) => Promise<unknown>) =>
              target.transaction(inner => fn(wrapTx(inner as unknown as Db)));
          }
          if (prop === "update") {
            return (table: unknown) => {
              const builder = (target.update as (t: unknown) => {
                set: (...args: unknown[]) => unknown;
              })(table);
              if (table === orders && !bumped) {
                bumped = true;
                return new Proxy(builder, {
                  get(bTarget, bProp, bReceiver) {
                    if (bProp === "set") {
                      return (...setArgs: unknown[]) => {
                        const whereBuilder = (bTarget.set as (...a: unknown[]) => { where: (...w: unknown[]) => unknown })(...setArgs);
                        return new Proxy(whereBuilder, {
                          get(wTarget, wProp, wReceiver) {
                            if (wProp === "where") {
                              return (...whereArgs: unknown[]) => {
                                const query = (wTarget.where as (...a: unknown[]) => PromiseLike<unknown> & { returning: (...r: unknown[]) => Promise<unknown> })(...whereArgs);
                                return new Proxy(query, {
                                  get(qTarget, qProp, qReceiver) {
                                    if (qProp === "returning") {
                                      return async (...retArgs: unknown[]) => {
                                        await target.update(orders).set({ version: sql`${orders.version} + 1` }).where(eq(orders.id, orderId));
                                        return (qTarget.returning as (...r: unknown[]) => Promise<unknown>)(...retArgs);
                                      };
                                    }
                                    return Reflect.get(qTarget, qProp, qReceiver);
                                  },
                                });
                              };
                            }
                            return Reflect.get(wTarget, wProp, wReceiver);
                          },
                        });
                      };
                    }
                    return Reflect.get(bTarget, bProp, bReceiver);
                  },
                });
              }
              return builder;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return wrapTx(db);
    }

    // 1. scheduleOrder stale-version conflict -> 409 CONFLICT_VERSION, 0 order.scheduled events.
    const seed = await seedWindow(db, { capacity: 5 });
    const dWin = await seedDeliveryWindow(db, seed, 5);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const customer = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const quote = await createQuote(db, customer, {
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId: dWin,
      tariffVersionId: catalog.tariffVersionId,
      key: `q-lock-${rid()}`,
      lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    const order = await createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: catalog.termsVersion,
      key: `o-lock-${rid()}`,
    });
    const sp = await holdSlot(db, { principal: customer, windowId: seed.windowId, key: `sp-${rid()}`, now: NOW, expiresAt: HOLD_TTL });
    const sd = await holdSlot(db, { principal: customer, windowId: dWin, key: `sd-${rid()}`, now: NOW, expiresAt: HOLD_TTL });

    await expect(scheduleOrder(withStaleOrderVersion(order.id), customer, {
      orderId: order.id, pickupReservationId: sp.reservationId, deliveryReservationId: sd.reservationId,
      key: `sched-stale-${rid()}`, now: NOW,
    })).rejects.toMatchObject({ status: 409, code: "CONFLICT_VERSION" });
    expect(await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateId, order.id),
      eq(outboxEvents.eventType, "order.scheduled"),
    ))).toHaveLength(0);

    // Schedule cleanly, then verify rescheduleOrder stale-version conflict -> 409 CONFLICT_VERSION, 0 order.rescheduled events.
    await scheduleOrder(db, customer, {
      orderId: order.id, pickupReservationId: sp.reservationId, deliveryReservationId: sd.reservationId,
      key: `sched-ok-${rid()}`, now: NOW,
    });
    const rp = await holdSlot(db, { principal: customer, windowId: seed.windowId, key: `rp-${rid()}`, now: NOW, expiresAt: HOLD_TTL });
    const rd = await holdSlot(db, { principal: customer, windowId: dWin, key: `rd-${rid()}`, now: NOW, expiresAt: HOLD_TTL });

    await expect(rescheduleOrder(withStaleOrderVersion(order.id), customer, {
      orderId: order.id, pickupReservationId: rp.reservationId, deliveryReservationId: rd.reservationId,
      key: `resched-stale-${rid()}`, now: NOW,
    })).rejects.toMatchObject({ status: 409, code: "CONFLICT_VERSION" });
    expect(await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateId, order.id),
      eq(outboxEvents.eventType, "order.rescheduled"),
    ))).toHaveLength(0);

    // 3. cancelOrder stale-version conflict -> 409 CONFLICT_VERSION, 0 order.cancelled events.
    await expect(cancelOrder(withStaleOrderVersion(order.id), customer, {
      orderId: order.id, reason: "stale cancel", key: `cancel-stale-${rid()}`,
    })).rejects.toMatchObject({ status: 409, code: "CONFLICT_VERSION" });
    expect(await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateId, order.id),
      eq(outboxEvents.eventType, "order.cancelled"),
    ))).toHaveLength(0);
  });

  it("lnd-7l3: createOrder rejects mismatched termsVersion even when alternate termsVersion is published", async () => {
    const seed = await seedWindow(db, { capacity: 3 });
    const dWin = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId, "offer-2026-11");
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const customer = makePrincipal(seed.organizationId, seed.userId, ["customer"]);

    // Publish a second offer document version in the same org.
    await db.insert(documentVersions).values({
      organizationId: seed.organizationId,
      kind: "offer",
      version: "offer-2026-12",
      contentHash: "hash-v2",
      bodyText: "Новая оферта",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const quote = await createQuote(db, customer, {
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId: dWin,
      tariffVersionId: catalog.tariffVersionId,
      key: `q-terms-${rid()}`,
      lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });

    await expect(createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: "offer-2026-12",
      key: `o-terms-bad-${rid()}`,
    })).rejects.toMatchObject({ status: 409, code: "CONFLICT_VERSION", message: "TERMS_VERSION_MISMATCH" });

    // Matching termsVersion succeeds.
    const created = await createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: "offer-2026-11",
      key: `o-terms-ok-${rid()}`,
    });
    expect(created.state).toBe("confirmed");
  });

  it("lnd-kdc: GET /orders/:id strips totalKopeks and declaredValueKopeks from partner and courier views, keeping them for customer/finance/admin/support", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const partner = await seedPartnerForOrder(db, f);
    const seal = await seedSeal(db, f.organizationId);
    await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-KDC-${rid().slice(0, 8)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [{
        itemCode: `IT-KDC-${rid().slice(0, 6)}`,
        category: "пальто",
        description: "Шерстяное пальто",
        declaredValueKopeks: 1_200_000,
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-kdc-${rid()}`,
    });

    const [partnerUser] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, partner.userId));
    const [courierUser] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, f.courierId));

    const partnerSession = await login(f.organizationId, partnerUser.phone!, ["laundry_operator"], partner.partnerId);
    const courierSession = await login(f.organizationId, courierUser.phone!, ["courier"]);
    const customerSession = await login(f.organizationId, f.phone, ["customer"]);
    const financeSession = await login(f.organizationId, `+7999${Math.floor(Math.random() * 1e7)}`, ["platform_finance"]);

    const partnerRes = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: partnerSession.cookie } });
    expect(partnerRes.statusCode).toBe(200);
    const partnerBody = partnerRes.json() as { totalKopeks?: number; garments: Array<{ declaredValueKopeks?: number }> };
    expect(partnerBody.totalKopeks).toBeUndefined();
    // FP-N10: assigned partner receives declaredValueKopeks for garment care/liability, while totalKopeks remains stripped.
    expect(partnerBody.garments[0].declaredValueKopeks).toBe(1_200_000);

    const courierRes = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: courierSession.cookie } });
    expect(courierRes.statusCode).toBe(200);
    const courierBody = courierRes.json() as { totalKopeks?: number; garments: Array<{ declaredValueKopeks?: number }> };
    expect(courierBody.totalKopeks).toBeUndefined();
    expect(courierBody.garments[0].declaredValueKopeks).toBeUndefined();

    for (const session of [customerSession, financeSession]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: session.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { totalKopeks?: number; garments: Array<{ declaredValueKopeks?: number }> };
      expect(typeof body.totalKopeks).toBe("number");
      expect(body.garments[0].declaredValueKopeks).toBe(1_200_000);
    }
  });

  it("lnd-5nx: returnUnprocessedOrder reuses releaseSlot, decrements reserved_orders accurately, and emits slot.released", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const partner = await seedPartnerForOrder(db, f);
    const seal = await seedSeal(db, f.organizationId);
    const containerCode = `BAG-RET-${rid().slice(0, 8)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-ret-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `recv-ret-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-ret-${rid()}` });

    const returned = await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Ткань не подлежит стирке",
      key: `ret-unproc-${rid()}`,
    });
    expect(returned.state).toBe("ready");
    expect(returned.releasedReservations).toBe(2);

    const [pickupWindow] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, f.windowId));
    const [deliveryWindow] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, f.deliveryWindowId));
    expect(pickupWindow.reservedOrders).toBe(0);
    expect(deliveryWindow.reservedOrders).toBe(0);
    expect(await reconcileCapacity(db, f.organizationId)).toEqual([]);

    const resRows = await db.select().from(slotReservations).where(eq(slotReservations.orderId, f.orderId));
    expect(resRows.every(r => r.state === "released")).toBe(true);

    const releasedEvents = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, f.organizationId),
      eq(outboxEvents.eventType, "slot.released"),
    ));
    expect(releasedEvents).toHaveLength(2);
  });

  it("lnd-7vq: safety_buffer_orders is enforced in holdSlot (capacity=10, safety_buffer=2 rejects 9th hold)", async () => {
    const seed = await seedWindow(db, { capacity: 10 });
    await db.update(serviceWindows).set({ safetyBufferOrders: 2 }).where(eq(serviceWindows.id, seed.windowId));
    const customer = makePrincipal(seed.organizationId, seed.userId, ["customer"]);

    for (let i = 1; i <= 8; i++) {
      const held = await holdSlot(db, {
        principal: customer,
        windowId: seed.windowId,
        key: `buf-hold-${i}-${rid()}`,
        now: NOW,
        expiresAt: HOLD_TTL,
      });
      expect(held.state).toBe("held");
    }

    await expect(holdSlot(db, {
      principal: customer,
      windowId: seed.windowId,
      key: `buf-hold-9-${rid()}`,
      now: NOW,
      expiresAt: HOLD_TTL,
    })).rejects.toMatchObject({ code: "CAPACITY_UNAVAILABLE" });

    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    expect(window.reservedOrders).toBe(8);
    expect(await reconcileCapacity(db, seed.organizationId)).toEqual([]);
  });

  it("lnd-8vs: suspended/revoked memberships cannot read or mutate any authenticated endpoint", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const admin = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_admin"]);
    const targetSession = await login(f.organizationId, f.phone, ["customer"]);

    // Active customer can read their order.
    const before = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: targetSession.cookie } });
    expect(before.statusCode).toBe(200);

    // Suspend membership -> existing session is immediately blocked on both read and write.
    await setMembershipState(db, admin, {
      userId: targetSession.userId,
      state: "suspended",
      reason: "security investigation",
      key: `suspend-${rid()}`,
    });
    const readSuspended = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: targetSession.cookie } });
    expect([401, 403]).toContain(readSuspended.statusCode);
    const writeSuspended = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${f.orderId}/cancel`,
      headers: { cookie: targetSession.cookie, "idempotency-key": `cancel-susp-${rid()}` },
      payload: { reason: "attempt while suspended" },
    });
    expect([401, 403]).toContain(writeSuspended.statusCode);

    // Revoke membership -> remains blocked.
    await setMembershipState(db, admin, {
      userId: targetSession.userId,
      state: "revoked",
      reason: "account terminated",
      key: `revoke-${rid()}`,
    });
    const readRevoked = await app.inject({ method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: targetSession.cookie } });
    expect([401, 403]).toContain(readRevoked.statusCode);
  });

  it("lnd-8vs: courier reassignment immediately revokes stale courier access to order and intake", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const [courierAUser] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, f.courierId));
    const courierASession = await login(f.organizationId, courierAUser.phone!, ["courier"]);

    // Courier A initially has access.
    const beforeReassign = await app.inject({
      method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: courierASession.cookie },
    });
    expect(beforeReassign.statusCode).toBe(200);

    // Create Courier B with an active shift and reassign the pickup stop.
    const courierBPhone = `+7999${Math.floor(Math.random() * 1e7)}`;
    const courierBSession = await login(f.organizationId, courierBPhone, ["courier"]);
    const [shiftB] = await db.insert(courierShifts).values({
      organizationId: f.organizationId,
      courierId: courierBSession.userId,
      state: "active",
      startsAt: new Date("2026-12-01T09:00:00Z"),
      endsAt: new Date("2026-12-01T18:00:00Z"),
    }).returning();

    await assignPickup(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: shiftB.id,
      key: `reassign-${rid()}`,
    });

    // Stale Courier A loses read access (404) and intake access (403).
    const staleRead = await app.inject({
      method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: courierASession.cookie },
    });
    expect(staleRead.statusCode).toBe(404);

    const seal = await seedSeal(db, f.organizationId);
    await expect(recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: `BAG-STALE-${rid().slice(0, 8)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `stale-intake-${rid()}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Reassigned Courier B has read access.
    const newCourierRead = await app.inject({
      method: "GET", url: `/api/v1/orders/${f.orderId}`, headers: { cookie: courierBSession.cookie },
    });
    expect(newCourierRead.statusCode).toBe(200);
  });

  it("lnd-8vs: DELETE /api/v1/evidence/:id enforces ABAC and legal-hold checks", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const ownerSession = await login(f.organizationId, f.phone, ["customer"]);
    const foreignCustomerSession = await login(f.organizationId, `+7999${Math.floor(Math.random() * 1e7)}`, ["customer"]);
    const otherTenant = await seedFullOrder(db, { state: "scheduled" });
    const foreignTenantSession = await login(otherTenant.organizationId, otherTenant.phone, ["customer"]);

    const ev1 = await registerEvidence(db, f.principal, {
      ownerType: "order", ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`, sha256: "a".repeat(64),
      purpose: "intake_condition", key: `reg1-${rid()}`,
    });
    const evHeld = await registerEvidence(db, f.principal, {
      ownerType: "order", ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`, sha256: "b".repeat(64),
      purpose: "intake_condition", key: `reg2-${rid()}`,
    });
    await db.insert(evidenceLegalHolds).values({
      organizationId: f.organizationId,
      assetId: evHeld.evidenceId,
      reason: "active dispute hold",
      placedBy: f.userId,
    });

    // Foreign same-tenant customer and foreign tenant are denied (404).
    const deniedSameTenant = await app.inject({
      method: "DELETE",
      url: `/api/v1/evidence/${ev1.evidenceId}`,
      headers: { cookie: foreignCustomerSession.cookie, "idempotency-key": `del-f1-${rid()}` },
    });
    expect(deniedSameTenant.statusCode).toBe(404);

    const deniedCrossTenant = await app.inject({
      method: "DELETE",
      url: `/api/v1/evidence/${ev1.evidenceId}`,
      headers: { cookie: foreignTenantSession.cookie, "idempotency-key": `del-f2-${rid()}` },
    });
    expect(deniedCrossTenant.statusCode).toBe(404);

    // Owner deleting legal-held evidence is blocked with 409 FINANCIAL_HOLD.
    const deniedHold = await app.inject({
      method: "DELETE",
      url: `/api/v1/evidence/${evHeld.evidenceId}`,
      headers: { cookie: ownerSession.cookie, "idempotency-key": `del-hold-${rid()}` },
    });
    expect(deniedHold.statusCode).toBe(409);
    expect(deniedHold.json().error.code).toBe("FINANCIAL_HOLD");

    // Owner deleting non-held evidence succeeds (200) and tombstones the row.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/evidence/${ev1.evidenceId}`,
      headers: { cookie: ownerSession.cookie, "idempotency-key": `del-ok-${rid()}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ evidenceId: ev1.evidenceId, deleted: true });

    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, ev1.evidenceId));
    expect(asset.deletedAt).not.toBeNull();
  });
});
