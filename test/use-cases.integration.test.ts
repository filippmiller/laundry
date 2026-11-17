import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { evidenceAssets, evidenceAccessEvents, orders, sessions } from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedSeal } from "./operations-fixtures.js";
import { openClaim, decideClaim } from "../src/services/claims.js";
import { recordIntake } from "../src/services/intake.js";
import { processOutbox } from "../src/services/outbox.js";
import {
  decideCompensation, listEvidence, listMySessions, opsMetrics, proposeCompensation,
  registerEvidence, revokeOwnSession, searchOrders,
} from "../src/services/workspace.js";
import {
  addAddress, listAddresses, listNotifications, markNotificationsRead, trackOrder,
} from "../src/services/customer.js";
import { completeShift, currentShift, openShift } from "../src/services/courier-shift.js";

const rid = () => randomUUID();
const sha = () => createHmac("sha256", rid()).update(rid()).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Ten missing use cases", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => {
    await close();
  });

  it("1+2: customer sees the notification feed and manages an address book", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: `BAG-${rid().slice(0, 6)}`, sealSerial: (await seedSeal(db, f.organizationId)).serial, weightGrams: 900 }],
      customerConfirmation: true, courierConfirmation: true, key: `intake-${rid()}`,
    });
    await processOutbox(db, { limit: 500 });

    const feed = await listNotifications(db, f.principal);
    expect(feed.length).toBeGreaterThanOrEqual(2);
    expect(feed.every((row) => row.read === false)).toBe(true);
    expect(feed.map((row) => row.template)).toContain("intake_confirmed");

    const marked = await markNotificationsRead(db, f.principal, { ids: feed.slice(0, 1).map((row) => row.id) });
    expect(marked.marked).toBe(1);
    const after = await listNotifications(db, f.principal);
    expect(after.find((row) => row.id === feed[0].id)?.read).toBe(true);

    const added = await addAddress(db, f.principal, {
      buildingId: f.buildingId, apartment: "42", notes: "код домофона не нужен", key: `addr-${rid()}`,
    });
    expect(added.buildingId).toBe(f.buildingId);
    const book = await listAddresses(db, f.principal);
    expect(book).toHaveLength(2);
    expect(book[0].apartment).toBe("42");
  });

  it("3: no-login tracking answers only with the exact phone", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const found = await trackOrder(db, f.organizationId, {
      publicNumber: order.publicNumber, phone: f.phone,
    });
    expect(found.publicNumber).toBe(order.publicNumber);
    expect(found.state).toBe("scheduled");

    await expect(trackOrder(db, f.organizationId, { publicNumber: order.publicNumber, phone: "+70000000000" }))
      .rejects.toThrow("NOT_FOUND");
    await expect(trackOrder(db, f.organizationId, { publicNumber: "NO-SUCH-NUMBER", phone: f.phone }))
      .rejects.toThrow("NOT_FOUND");
  });

  it("4+5: courier opens a shift, reuses it, and closes it with a reconciliation", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const first = await openShift(db, f.courier, { key: `shift-${rid()}` });
    expect(first.state).toBe("active");
    const again = await openShift(db, f.courier, { key: `shift-${rid()}` });
    expect(again.shiftId).toBe(first.shiftId);
    expect(again.state).toBe("active");
    expect((again as { reused?: boolean }).reused).toBe(true);
    expect((await currentShift(db, f.courier))?.shiftId).toBe(first.shiftId);

    const summary = await completeShift(db, f.courier, { shiftId: first.shiftId, key: `done-${rid()}` });
    expect(summary.state).toBe("completed");
    expect(summary.replayed).toBe(false);
    const replay = await completeShift(db, f.courier, { shiftId: first.shiftId, key: `done2-${rid()}` });
    expect(replay.state).toBe("completed");
    expect((replay as { alreadyCompleted?: boolean }).alreadyCompleted).toBe(true);
    expect(await currentShift(db, f.courier)).toBeNull();
    expect((await openShift(db, f.courier, { key: `shift-${rid()}` })).reused).toBe(false);
  });

  it("6: a user lists and revokes their own sessions only", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [first] = await db.insert(sessions).values({
      organizationId: f.organizationId, userId: f.principal.userId,
      tokenHash: `tok-${rid()}`, expiresAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const [second] = await db.insert(sessions).values({
      organizationId: f.organizationId, userId: f.principal.userId,
      tokenHash: `tok-${rid()}`, expiresAt: new Date(Date.now() + 3_600_000),
    }).returning();
    const mine = makePrincipal(f.organizationId, f.principal.userId, ["customer"], { sessionId: first.id });

    const before = await listMySessions(db, mine);
    expect(before.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    expect(before.find((row) => row.id === first.id)?.current).toBe(true);

    const revoked = await revokeOwnSession(db, mine, { sessionId: second.id, key: `s-${rid()}` });
    expect(revoked.revoked).toBe(true);
    const after = await listMySessions(db, mine);
    expect(after.map((row) => row.id)).toContain(first.id);
    expect(after.map((row) => row.id)).not.toContain(second.id);

    const strangerSession = await db.insert(sessions).values({
      organizationId: f.organizationId, userId: await seedUser(db, f.organizationId),
      tokenHash: `tok-${rid()}`, expiresAt: new Date(Date.now() + 3_600_000),
    }).returning();
    await expect(revokeOwnSession(db, mine, { sessionId: strangerSession[0].id, key: `s-${rid()}` }))
      .rejects.toThrow("NOT_FOUND");
  });

  it("7: ops metrics reflect the fixture order and stay read-only", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const dispatcher = makePrincipal(f.organizationId, f.dispatcher.userId, ["dispatcher"]);
    const metrics = await opsMetrics(db, dispatcher);
    expect(metrics.ordersByState.scheduled).toBeGreaterThanOrEqual(1);
    expect(metrics.activeShifts).toBeGreaterThanOrEqual(0);
    expect(Object.keys(metrics)).toEqual([
      "ordersByState", "openClaims", "openThreads", "capturedKopeks", "pendingOutbox", "activeShifts",
    ]);
    const again = await opsMetrics(db, dispatcher);
    expect(again).toEqual(metrics);
  });

  it("8: evidence registration is hash-validated, owner-scoped and access-logged", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const registered = await registerEvidence(db, f.principal, {
      ownerType: "order", ownerId: f.orderId, objectKey: `evidence/${rid()}.jpg`,
      sha256: sha(), purpose: "damaged_garment", mimeType: "image/jpeg", sizeBytes: 12_345, key: `ev-${rid()}`,
    });
    expect(registered.status).toBe("pending_upload");

    await expect(registerEvidence(db, f.principal, {
      ownerType: "order", ownerId: f.orderId, objectKey: `evidence/${rid()}.jpg`,
      sha256: "not-a-hash", purpose: "broken", key: `ev-${rid()}`,
    })).rejects.toThrow("SHA256_FORMAT_INVALID");

    const foreign = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(registerEvidence(db, foreign, {
      ownerType: "order", ownerId: f.orderId, objectKey: `evidence/${rid()}.jpg`,
      sha256: sha(), purpose: "not mine", key: `ev-${rid()}`,
    })).rejects.toThrow("NOT_FOUND");

    const listed = await listEvidence(db, f.principal, "order", f.orderId);
    expect(listed).toHaveLength(1);
    const access = await db.select().from(evidenceAccessEvents)
      .where(eq(evidenceAccessEvents.assetId, registered.evidenceId));
    expect(access).toHaveLength(1);
    expect(await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, registered.evidenceId))).toHaveLength(1);
  });

  it("9: compensation is proposed by support and decided by finance", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId, claimType: "damaged", description: "пятно не отстиралось", key: `claim-${rid()}`,
    });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    await expect(proposeCompensation(db, support, { claimId: claim.claimId, amountKopeks: 500, key: `c-${rid()}` }))
      .rejects.toThrow("CLAIM_NOT_DECIDABLE");

    await decideClaim(db, approver, {
      claimId: claim.claimId, outcome: "resolved", rationale: "решено в пользу клиента", key: `dec-${rid()}`,
    });
    const proposed = await proposeCompensation(db, support, { claimId: claim.claimId, amountKopeks: 500, key: `c-${rid()}` });
    expect(proposed.state).toBe("proposed");

    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const approved = await decideCompensation(db, finance, { compensationId: proposed.compensationId, approve: true, key: `d-${rid()}` });
    expect(approved.state).toBe("approved");
    const replay = await decideCompensation(db, finance, { compensationId: proposed.compensationId, approve: false, key: `d-${rid()}` });
    expect(replay.state).toBe("approved");
  });

  it("10: support finds an order by exact public number or phone", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const byNumber = await searchOrders(db, support, order.publicNumber);
    expect(byNumber.map((row) => row.id)).toContain(f.orderId);
    const byPhone = await searchOrders(db, support, f.phone);
    expect(byPhone.map((row) => row.id)).toContain(f.orderId);
    await expect(searchOrders(db, support, "ab")).rejects.toThrow("QUERY_TOO_SHORT");
    const stranger = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(searchOrders(db, stranger, order.publicNumber)).rejects.toThrow();
  });
});
