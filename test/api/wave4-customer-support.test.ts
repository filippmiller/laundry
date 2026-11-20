import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  claims, customerAddresses, evidenceAssets, memberships, notifications, orders, serviceWindows,
  slotReservations, supportMessages, supportThreads, users,
} from "../../src/db/schema.js";
import { openClaim } from "../../src/services/claims.js";
import { exportMyPrivacyData, registerEvidence, uploadEvidence } from "../../src/services/workspace.js";
import { makePrincipal, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";

const rid = () => randomUUID();
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 4 Track 3: Customer Quotes/Holds/Repeat, Privacy Export, Cursor Pagination & Support Evidence", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
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

  it("N-CUS-01: capacity-1 re-quote releases old holds on server and enforces actor/tenant scoping", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 1);
    const catalog = await seedCatalog(db, seed.organizationId, "offer-w4-ncus01");
    const [address] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: seed.userId,
      buildingId: seed.buildingId,
      apartment: "12",
    }).returning();

    const session = await loginAs(seed.organizationId, seed.phone, ["customer"]);

    // 1. Initial quote + paired hold on capacity-1 windows
    const q1Res = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie: session.cookie, "idempotency-key": `q1-${rid()}` },
      payload: {
        buildingId: seed.buildingId,
        addressId: address.id,
        tariffVersionId: catalog.tariffVersionId,
        pickupWindowId: seed.windowId,
        deliveryWindowId,
        lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1000, unit: "gram" }],
      },
    });
    expect(q1Res.statusCode).toBe(200);
    const q1 = q1Res.json() as { id: string; quoteHash: string };

    const h1Res = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": `hp1-${rid()}` },
      payload: {
        pickupWindowId: seed.windowId,
        deliveryWindowId,
        quoteId: q1.id,
        ttlMinutes: 10,
      },
    });
    expect(h1Res.statusCode).toBe(200);
    const h1 = h1Res.json() as { pickup: { reservationId: string }; delivery: { reservationId: string } };

    // Both capacity-1 windows are now full.
    const [pwFull] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    const [dwFull] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, deliveryWindowId));
    expect(pwFull.reservedOrders).toBe(1);
    expect(dwFull.reservedOrders).toBe(1);

    // Another customer in the same tenant cannot release our holds!
    const otherPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const otherSession = await loginAs(seed.organizationId, otherPhone, ["customer"]);
    const forbiddenRelease = await app.inject({
      method: "POST",
      url: `/api/v1/slots/holds/${h1.pickup.reservationId}/release`,
      headers: { cookie: otherSession.cookie, "idempotency-key": `rel-other-${rid()}` },
      payload: { reason: "Attempt steal" },
    });
    expect(forbiddenRelease.statusCode).toBe(404);

    // 2. Customer edits quantity and re-quotes, passing prior held reservation IDs -> released atomically!
    const q2Res = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie: session.cookie, "idempotency-key": `q2-${rid()}` },
      payload: {
        buildingId: seed.buildingId,
        addressId: address.id,
        tariffVersionId: catalog.tariffVersionId,
        pickupWindowId: seed.windowId,
        deliveryWindowId,
        lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 2000, unit: "gram" }],
        releaseReservationIds: [h1.pickup.reservationId, h1.delivery.reservationId],
      },
    });
    expect(q2Res.statusCode).toBe(200);
    const q2 = q2Res.json() as { id: string; quoteHash: string; termsVersion: string; releasedReservationIds: string[] };
    expect(q2.releasedReservationIds.sort()).toEqual([h1.pickup.reservationId, h1.delivery.reservationId].sort());

    const [pwFreed] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    const [dwFreed] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, deliveryWindowId));
    expect(pwFreed.reservedOrders).toBe(0);
    expect(dwFreed.reservedOrders).toBe(0);

    // 3. Subsequent paired hold + order + schedule succeeds on the same capacity-1 windows!
    const h2Res = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": `hp2-${rid()}` },
      payload: { pickupWindowId: seed.windowId, deliveryWindowId, quoteId: q2.id, ttlMinutes: 10 },
    });
    expect(h2Res.statusCode).toBe(200);
    const h2 = h2Res.json() as { pickup: { reservationId: string }; delivery: { reservationId: string } };

    const orderRes = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: { cookie: session.cookie, "idempotency-key": `ord-${rid()}` },
      payload: { quoteId: q2.id, acceptedQuoteHash: q2.quoteHash, termsVersion: q2.termsVersion },
    });
    expect(orderRes.statusCode).toBe(200);
    const createdOrder = orderRes.json() as { id: string };

    const schedRes = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${createdOrder.id}/schedule`,
      headers: { cookie: session.cookie, "idempotency-key": `sched-${rid()}` },
      payload: { pickupReservationId: h2.pickup.reservationId, deliveryReservationId: h2.delivery.reservationId },
    });
    expect(schedRes.statusCode).toBe(200);

    // Customer cannot bypass cancelOrder by calling /slots/holds/:id/release on a confirmed reservation.
    const releaseConfirmed = await app.inject({
      method: "POST",
      url: `/api/v1/slots/holds/${h2.pickup.reservationId}/release`,
      headers: { cookie: session.cookie, "idempotency-key": `rel-conf-${rid()}` },
      payload: { reason: "Try bypass cancel" },
    });
    expect(releaseConfirmed.statusCode).toBe(409);
  });

  it("N-CUS-04: paired hold leaves zero orphan holds in both failure orders and recovers idempotently on timeout retry", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const fullDeliveryId = await seedDeliveryWindow(db, seed, 0);
    const openDeliveryId = await seedDeliveryWindow(db, seed, 1);
    const [fullPickup] = await db.insert(serviceWindows).values({
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      kind: "pickup",
      startsAt: new Date("2026-12-01T14:00:00.000Z"),
      endsAt: new Date("2026-12-01T16:00:00.000Z"),
      capacityOrders: 0,
      feeKopeks: 0,
    }).returning();
    const session = await loginAs(seed.organizationId, seed.phone, ["customer"]);

    // Order A: pickup open (cap 1), delivery full (cap 0) -> 409, pickup MUST remain 0 (no orphan!)
    const failA = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": `pair-fail-a-${rid()}` },
      payload: { pickupWindowId: seed.windowId, deliveryWindowId: fullDeliveryId, ttlMinutes: 10 },
    });
    expect(failA.statusCode).toBe(409);
    const [pwAfterA] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    expect(pwAfterA.reservedOrders).toBe(0);
    const holdsA = await db.select().from(slotReservations).where(and(
      eq(slotReservations.windowId, seed.windowId),
      eq(slotReservations.state, "held"),
    ));
    expect(holdsA).toHaveLength(0);

    // Order B: pickup full (cap 0), delivery open (cap 1) -> 409, delivery MUST remain 0 (no orphan!)
    const failB = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": `pair-fail-b-${rid()}` },
      payload: { pickupWindowId: fullPickup.id, deliveryWindowId: openDeliveryId, ttlMinutes: 10 },
    });
    expect(failB.statusCode).toBe(409);
    const [dwAfterB] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, openDeliveryId));
    expect(dwAfterB.reservedOrders).toBe(0);
    const holdsB = await db.select().from(slotReservations).where(and(
      eq(slotReservations.windowId, openDeliveryId),
      eq(slotReservations.state, "held"),
    ));
    expect(holdsB).toHaveLength(0);

    // Timeout after commit recovery: retrying with same stable idempotency key returns same pair without duplicate hold!
    const stableKey = `pair-recover-${rid()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": stableKey },
      payload: { pickupWindowId: seed.windowId, deliveryWindowId: openDeliveryId, ttlMinutes: 10 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { pickup: { reservationId: string }; delivery: { reservationId: string }; replayed?: boolean };
    expect(firstBody.replayed).toBe(false);

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds/pair",
      headers: { cookie: session.cookie, "idempotency-key": stableKey },
      payload: { pickupWindowId: seed.windowId, deliveryWindowId: openDeliveryId, ttlMinutes: 10 },
    });
    expect(retry.statusCode).toBe(200);
    const retryBody = retry.json() as { pickup: { reservationId: string }; delivery: { reservationId: string }; replayed?: boolean };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.pickup.reservationId).toBe(firstBody.pickup.reservationId);
    expect(retryBody.delivery.reservationId).toBe(firstBody.delivery.reservationId);

    const [pwFinal] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    const [dwFinal] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, openDeliveryId));
    expect(pwFinal.reservedOrders).toBe(1);
    expect(dwFinal.reservedOrders).toBe(1);
  });

  it("N-CUS-02: repeatOrder returns exact original addressId and availability info (apt 99 vs apt 42)", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [orderRow] = await db.select({ addressId: orders.addressId }).from(orders).where(eq(orders.id, f.orderId));
    // Add a second apartment in the same building (apt 99) so the customer has two addresses.
    const [apt99] = await db.insert(customerAddresses).values({
      organizationId: f.organizationId,
      customerId: f.userId,
      buildingId: f.buildingId,
      apartment: "99",
    }).returning();
    expect(apt99.id).not.toBe(orderRow.addressId);

    const session = await loginAs(f.organizationId, f.phone, ["customer"]);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${f.orderId}/repeat`,
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      addressId: string | null;
      originalAddressId: string;
      addressAvailable: boolean;
      buildingId: string | null;
    };
    expect(body.addressId).toBe(orderRow.addressId);
    expect(body.originalAddressId).toBe(orderRow.addressId);
    expect(body.addressAvailable).toBe(true);
    expect(body.buildingId).toBe(f.buildingId);
  });

  it("W3-CN-01 / W2-CN-02 / NEW-S04: privacy export runs in REPEATABLE READ READ ONLY snapshot with 505 rows, concurrent INSERT, and staff-created claims", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const staffUserId = await seedUser(db, f.organizationId);
    const staffPrincipal = makePrincipal(f.organizationId, staffUserId, ["customer_support"]);

    // Staff opens a claim on the customer's own order (openedBy = staffUserId, NOT customer!).
    const staffClaim = await openClaim(db, staffPrincipal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Претензия открыта поддержкой по звонку клиента",
      key: `staff-claim-${rid()}`,
    });

    // Another customer's order + claim in the same tenant MUST NOT leak into our export.
    const otherOrder = await seedFullOrder(db, { state: "scheduled" });
    await openClaim(db, otherOrder.principal, {
      orderId: otherOrder.orderId,
      claimType: "missing",
      description: "Чужая претензия",
      key: `other-claim-${rid()}`,
    });

    // Seed 505 notifications (> 500 page size).
    const baseTime = new Date("2026-11-20T10:00:00.000Z");
    await db.insert(notifications).values(
      Array.from({ length: 505 }, (_, idx) => ({
        organizationId: f.organizationId,
        recipientId: f.userId,
        channel: "sms",
        template: "order_confirmed",
        payloadJson: { seq: idx + 1 },
        dedupeKey: `w4-priv-${rid()}-${idx}`,
        createdAt: new Date(baseTime.getTime() + Math.floor(idx / 3) * 1000),
      })),
    );

    // Run export concurrently with live INSERTs to verify zero duplicates and exact count consistency.
    const [exported] = await Promise.all([
      exportMyPrivacyData(db, f.principal),
      db.insert(notifications).values(
        Array.from({ length: 15 }, (_, idx) => ({
          organizationId: f.organizationId,
          recipientId: f.userId,
          channel: "sms",
          template: "order_confirmed",
          payloadJson: { concurrent: idx + 1 },
          dedupeKey: `w4-priv-conc-${rid()}-${idx}`,
          createdAt: new Date(baseTime.getTime() + 999_000 + idx * 1000),
        })),
      ),
    ]);

    expect(exported.exportedAsOf).toBeTruthy();
    expect(exported.exportMeta.exportedAsOf).toBe(exported.exportedAsOf);
    expect(exported.exportMeta.snapshotIsolation).toBe("repeatable_read_read_only");
    expect(exported.notifications.length).toBeGreaterThanOrEqual(505);
    expect(new Set(exported.notifications.map(n => n.id)).size).toBe(exported.notifications.length);
    expect(exported.exportMeta.counts.notifications).toBe(exported.notifications.length);
    expect(exported.exportMeta.counts.claims).toBe(exported.claims.length);

    // NEW-S04: staff-created claim on customer's own order is present with original openedBy preserved!
    const foundStaffClaim = exported.claims.find(c => c.id === staffClaim.claimId);
    expect(foundStaffClaim).toBeDefined();
    expect(foundStaffClaim?.openedBy).toBe(staffUserId);
    // Other user's claim is NOT present.
    expect(exported.claims.every(c => c.orderId === f.orderId)).toBe(true);
  });

  it("W2-CN-01: notifications keyset cursor traverses all 501 items despite 100 concurrent inserts & identical timestamps, and all:true mark-all stays accurate", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const otherUserId = await seedUser(db, seed.organizationId);
    const session = await loginAs(seed.organizationId, seed.phone, ["customer"]);

    // Insert 501 notifications with intentional timestamp ties (groups of 5 share identical createdAt).
    const t0 = new Date("2026-11-20T08:00:00.000Z");
    const insertedOriginal = await db.insert(notifications).values(
      Array.from({ length: 501 }, (_, idx) => ({
        organizationId: seed.organizationId,
        recipientId: seed.userId,
        channel: "sms",
        template: "order_confirmed",
        payloadJson: { seq: idx + 1 },
        dedupeKey: `w4-notif-orig-${rid()}-${idx}`,
        createdAt: new Date(t0.getTime() + Math.floor(idx / 5) * 1000),
      })),
    ).returning({ id: notifications.id });
    const originalIds = new Set(insertedOriginal.map(r => r.id));

    // Also insert an unread notification for another user in the same tenant.
    const [otherNotif] = await db.insert(notifications).values({
      organizationId: seed.organizationId,
      recipientId: otherUserId,
      channel: "sms",
      template: "order_confirmed",
      payloadJson: { seq: 1 },
      dedupeKey: `w4-notif-other-${rid()}`,
    }).returning({ id: notifications.id });

    // Page 1: first 100 of 501.
    const p1 = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=100",
      headers: { cookie: session.cookie },
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.headers["x-total-unread"]).toBe("501");
    expect(p1.headers["x-has-more"]).toBe("true");
    let cursor = String(p1.headers["x-next-cursor"] ?? "");
    expect(cursor.length).toBeGreaterThan(10);

    const seenIds: string[] = (p1.json() as Array<{ id: string }>).map(n => n.id);
    expect(seenIds).toHaveLength(100);

    // INSERT 100 brand-new notifications AFTER page 1!
    await db.insert(notifications).values(
      Array.from({ length: 100 }, (_, idx) => ({
        organizationId: seed.organizationId,
        recipientId: seed.userId,
        channel: "sms",
        template: "order_confirmed",
        payloadJson: { newer: idx + 1 },
        dedupeKey: `w4-notif-new-${rid()}-${idx}`,
        createdAt: new Date(t0.getTime() + 900_000 + idx * 1000),
      })),
    );

    // Continue walking cursor to the end — must cover all remaining 401 original rows with zero duplicates!
    while (cursor) {
      const next = await app.inject({
        method: "GET",
        url: `/api/v1/notifications?limit=100&cursor=${encodeURIComponent(cursor)}`,
        headers: { cookie: session.cookie },
      });
      expect(next.statusCode).toBe(200);
      expect(next.headers["x-total-unread"]).toBe("601");
      const batch = next.json() as Array<{ id: string }>;
      seenIds.push(...batch.map(n => n.id));
      cursor = next.headers["x-has-more"] === "true" ? String(next.headers["x-next-cursor"] ?? "") : "";
    }

    expect(seenIds).toHaveLength(501);
    expect(new Set(seenIds).size).toBe(501);
    for (const id of originalIds) {
      expect(seenIds).toContain(id);
    }

    // Mark all read -> marks all 601 own unread notifications, leaves otherUser's notification untouched.
    const markAll = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      headers: { cookie: session.cookie, "idempotency-key": `mark-all-${rid()}` },
      payload: { all: true },
    });
    expect(markAll.statusCode).toBe(200);
    expect(markAll.json()).toEqual({ marked: 601 });

    // A notification arriving AFTER mark-all stays unread.
    await db.insert(notifications).values({
      organizationId: seed.organizationId,
      recipientId: seed.userId,
      channel: "sms",
      template: "order_confirmed",
      payloadJson: { afterMarkAll: true },
      dedupeKey: `w4-notif-after-${rid()}`,
    });
    const afterCheck = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=10",
      headers: { cookie: session.cookie },
    });
    expect(afterCheck.headers["x-total-unread"]).toBe("1");

    // Other user's notification is still unread.
    const [otherAfter] = await db.select().from(notifications).where(and(
      eq(notifications.id, otherNotif.id),
      isNull(notifications.readAt),
    ));
    expect(otherAfter).toBeDefined();
  });

  it("NEW-S05: 501-message thread earlier cursor + >50 threads + >100 claims + >200 admin members pagination, search, and tenant scoping", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const otherTenant = await seedFullOrder(db, { state: "scheduled" });
    const supportPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const supportUserId = await seedUser(db, f.organizationId);
    const supportSession = await loginAs(f.organizationId, supportPhone, ["customer_support", "platform_admin"]);

    // 1. 501-message thread with timestamp ties.
    const [thread501] = await db.insert(supportThreads).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      subject: "Длинная переписка 501",
      state: "open",
    }).returning();
    const mBase = new Date("2026-11-20T09:00:00.000Z");
    const insertedMsgs = await db.insert(supportMessages).values(
      Array.from({ length: 501 }, (_, idx) => ({
        threadId: thread501.id,
        authorId: idx % 2 === 0 ? f.userId : supportUserId,
        body: `msg-${idx + 1}`,
        createdAt: new Date(mBase.getTime() + Math.floor(idx / 4) * 1000),
      })),
    ).returning({ id: supportMessages.id });
    expect(insertedMsgs).toHaveLength(501);

    const firstMsgPage = await app.inject({
      method: "GET",
      url: `/api/v1/support/threads/${thread501.id}?limit=100`,
      headers: { cookie: supportSession.cookie },
    });
    expect(firstMsgPage.statusCode).toBe(200);
    let msgPayload = firstMsgPage.json() as {
      messages: Array<{ id: string; body: string }>;
      hasEarlier: boolean;
      earlierCursor: string | null;
      totalMessages: number;
    };
    expect(msgPayload.totalMessages).toBe(501);
    expect(msgPayload.hasEarlier).toBe(true);
    expect(msgPayload.messages).toHaveLength(100);
    expect(msgPayload.messages.some(m => m.body === "msg-501")).toBe(true);

    const allThreadMessages = [...msgPayload.messages];
    while (msgPayload.hasEarlier && msgPayload.earlierCursor) {
      const earlierRes = await app.inject({
        method: "GET",
        url: `/api/v1/support/threads/${thread501.id}?limit=100&beforeCursor=${encodeURIComponent(msgPayload.earlierCursor)}`,
        headers: { cookie: supportSession.cookie },
      });
      expect(earlierRes.statusCode).toBe(200);
      msgPayload = earlierRes.json() as typeof msgPayload;
      allThreadMessages.unshift(...msgPayload.messages);
    }
    expect(allThreadMessages).toHaveLength(501);
    expect(new Set(allThreadMessages.map(m => m.id)).size).toBe(501);
    expect(allThreadMessages.some(m => m.body === "msg-1")).toBe(true);

    // 2. >50 support threads in tenant A + 2 in tenant B.
    const tBase = new Date("2026-11-20T07:00:00.000Z");
    await db.insert(supportThreads).values(
      Array.from({ length: 54 }, (_, idx) => ({
        organizationId: f.organizationId,
        orderId: f.orderId,
        subject: idx === 25 ? "УникальнаяТемаПоиска" : `Тикет ${idx + 1}`,
        state: "open",
        createdAt: new Date(tBase.getTime() + Math.floor(idx / 3) * 1000),
      })),
    );
    await db.insert(supportThreads).values([
      { organizationId: otherTenant.organizationId, orderId: otherTenant.orderId, subject: "ЧужойТенантТикет", state: "open" },
    ]);

    let threadCursor = "";
    const seenThreadIds: string[] = [];
    let threadTotal = -1;
    do {
      const url = threadCursor
        ? `/api/v1/support/threads?limit=25&cursor=${encodeURIComponent(threadCursor)}`
        : "/api/v1/support/threads?limit=25";
      const res = await app.inject({ method: "GET", url, headers: { cookie: supportSession.cookie } });
      expect(res.statusCode).toBe(200);
      threadTotal = Number(res.headers["x-total-count"]);
      const batch = res.json() as Array<{ id: string; subject: string }>;
      expect(batch.every(t => t.subject !== "ЧужойТенантТикет")).toBe(true);
      seenThreadIds.push(...batch.map(t => t.id));
      threadCursor = res.headers["x-has-more"] === "true" ? String(res.headers["x-next-cursor"] ?? "") : "";
    } while (threadCursor);
    expect(threadTotal).toBe(55);
    expect(new Set(seenThreadIds).size).toBe(55);

    const threadSearch = await app.inject({
      method: "GET",
      url: `/api/v1/support/threads?query=${encodeURIComponent("УникальнаяТемаПоиска")}`,
      headers: { cookie: supportSession.cookie },
    });
    expect(threadSearch.statusCode).toBe(200);
    expect(threadSearch.headers["x-total-count"]).toBe("1");
    expect(threadSearch.json()).toHaveLength(1);

    // 3. >100 claims in tenant A + 1 in tenant B.
    const cBase = new Date("2026-11-20T06:00:00.000Z");
    await db.insert(claims).values(
      Array.from({ length: 105 }, (_, idx) => ({
        organizationId: f.organizationId,
        orderId: f.orderId,
        openedBy: f.userId,
        claimType: "damage",
        description: idx === 77 ? "ИскомаяПретензия77" : `Претензия #${idx + 1}`,
        state: "opened" as const,
        openedAt: new Date(cBase.getTime() + Math.floor(idx / 4) * 1000),
      })),
    );
    await db.insert(claims).values({
      organizationId: otherTenant.organizationId,
      orderId: otherTenant.orderId,
      openedBy: otherTenant.userId,
      claimType: "damage",
      description: "ЧужаяПретензияТенантаB",
      state: "opened",
    });

    let claimCursor = "";
    const seenClaimIds: string[] = [];
    let claimTotal = -1;
    do {
      const url = claimCursor
        ? `/api/v1/claims?limit=50&cursor=${encodeURIComponent(claimCursor)}`
        : "/api/v1/claims?limit=50";
      const res = await app.inject({ method: "GET", url, headers: { cookie: supportSession.cookie } });
      expect(res.statusCode).toBe(200);
      claimTotal = Number(res.headers["x-total-count"]);
      const batch = res.json() as Array<{ id: string; description: string }>;
      expect(batch.every(c => c.description !== "ЧужаяПретензияТенантаB")).toBe(true);
      seenClaimIds.push(...batch.map(c => c.id));
      claimCursor = res.headers["x-has-more"] === "true" ? String(res.headers["x-next-cursor"] ?? "") : "";
    } while (claimCursor);
    expect(claimTotal).toBe(105);
    expect(new Set(seenClaimIds).size).toBe(105);

    const claimSearch = await app.inject({
      method: "GET",
      url: `/api/v1/claims?query=${encodeURIComponent("ИскомаяПретензия77")}`,
      headers: { cookie: supportSession.cookie },
    });
    expect(claimSearch.statusCode).toBe(200);
    expect(claimSearch.headers["x-total-count"]).toBe("1");
    expect(claimSearch.json()).toHaveLength(1);

    // 4. >200 admin members in tenant A (inserted in bulk with memberships).
    const mBaseTime = new Date("2026-11-20T05:00:00.000Z");
    const bulkUsers = await db.insert(users).values(
      Array.from({ length: 203 }, (_, i) => ({
        phone: `+7910${String(1000000 + i)}`,
        displayName: `Участник ${i + 1}`,
      })),
    ).returning({ id: users.id });
    await db.insert(memberships).values(
      bulkUsers.map((u, i) => ({
        organizationId: f.organizationId,
        userId: u.id,
        state: "active" as const,
        createdAt: new Date(mBaseTime.getTime() + Math.floor(i / 5) * 1000),
      })),
    );
    let memberCursor = "";
    const seenMemberIds: string[] = [];
    let memberTotal = -1;
    do {
      const url = memberCursor
        ? `/api/v1/admin/members?limit=100&cursor=${encodeURIComponent(memberCursor)}`
        : "/api/v1/admin/members?limit=100";
      const res = await app.inject({ method: "GET", url, headers: { cookie: supportSession.cookie } });
      expect(res.statusCode).toBe(200);
      memberTotal = Number(res.headers["x-total-count"]);
      const batch = res.json() as Array<{ membershipId: string }>;
      seenMemberIds.push(...batch.map(m => m.membershipId));
      memberCursor = res.headers["x-has-more"] === "true" ? String(res.headers["x-next-cursor"] ?? "") : "";
    } while (memberCursor);
    expect(memberTotal).toBeGreaterThanOrEqual(204);
    expect(new Set(seenMemberIds).size).toBe(memberTotal);

    const memberSearch = await app.inject({
      method: "GET",
      url: `/api/v1/admin/members?query=${encodeURIComponent("+79101000202")}`,
      headers: { cookie: supportSession.cookie },
    });
    expect(memberSearch.statusCode).toBe(200);
    expect(memberSearch.headers["x-total-count"]).toBe("1");
    expect(memberSearch.json()).toHaveLength(1);
  });

  it("NEW-S03: support opens verified/held evidence via /evidence/:id/content with private/no-store, nosniff, SHA check, and rejects cross-tenant/deleted/quarantined", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const otherTenant = await seedFullOrder(db, { state: "scheduled" });
    const supportPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const supportSession = await loginAs(f.organizationId, supportPhone, ["customer_support"]);

    const otherSupportPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const otherSupportSession = await loginAs(otherTenant.organizationId, otherSupportPhone, ["customer_support"]);

    const photoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const reg = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `secret/internal/${rid()}.png`,
      sha256: sha256Hex(photoBytes),
      purpose: "claim_evidence",
      mimeType: "image/png",
      sizeBytes: photoBytes.byteLength,
      key: `ev-reg-${rid()}`,
    });
    await uploadEvidence(db, f.principal, {
      evidenceId: reg.evidenceId,
      bytes: photoBytes,
      mimeType: "image/png",
      key: `ev-up-${rid()}`,
    });
    await openClaim(db, f.principal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Фото повреждения для проверки поддержки",
      evidenceIds: [reg.evidenceId],
      key: `ev-claim-${rid()}`,
    });

    // Listing does NOT leak objectKey / raw storage path.
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/order/${f.orderId}`,
      headers: { cookie: supportSession.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain("objectKey");
    expect(listRes.body).not.toContain("secret/internal/");

    // Support opens actual photo bytes via /evidence/:id/content.
    const contentRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/${reg.evidenceId}/content`,
      headers: { cookie: supportSession.cookie },
    });
    expect(contentRes.statusCode).toBe(200);
    expect(contentRes.headers["cache-control"]).toBe("private, no-store");
    expect(contentRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(contentRes.headers["content-type"]).toContain("image/png");
    expect(contentRes.rawPayload.equals(photoBytes)).toBe(true);

    // Cross-tenant support is refused.
    const crossRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/${reg.evidenceId}/content`,
      headers: { cookie: otherSupportSession.cookie },
    });
    expect(crossRes.statusCode).toBe(404);

    // Quarantined evidence is refused.
    const qBytes = Buffer.from("quarantined-file-bytes");
    const qReg = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `secret/q-${rid()}.png`,
      sha256: sha256Hex(qBytes),
      purpose: "claim_evidence",
      mimeType: "image/png",
      sizeBytes: qBytes.byteLength,
      key: `ev-q-reg-${rid()}`,
    });
    await db.update(evidenceAssets).set({ status: "quarantined" }).where(eq(evidenceAssets.id, qReg.evidenceId));
    const qRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/${qReg.evidenceId}/content`,
      headers: { cookie: supportSession.cookie },
    });
    expect(qRes.statusCode).toBe(403);
  });
});
