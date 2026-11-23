import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import {
  claims, customerAddresses, deliveryAttempts, memberships, membershipRoles, orders, scanEvents, sessions,
} from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder } from "./operations-fixtures.js";
import {
  grantRole, listAuditEvents, listMembers, memberRoles, revokeRole, revokeSession,
} from "../src/services/admin.js";
import { fraudSignals } from "../src/services/fraud.js";
import { capturePayment, createCustomerInvoice, refundPayment } from "../src/services/finance.js";
import { principalFromToken } from "../src/services/auth.js";

const rid = () => randomUUID();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Admin authority and fraud review queue", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function orgWithAdmin() {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const adminId = await seedUser(db, f.organizationId);
    const [membership] = await db.insert(memberships).values({ organizationId: f.organizationId, userId: adminId }).returning();
    await db.insert(membershipRoles).values({ membershipId: membership.id, role: "platform_admin" });
    const admin = makePrincipal(f.organizationId, adminId, ["platform_admin"]);
    return { ...f, admin, adminMembershipId: membership.id };
  }

  it("denies member administration to non-admins", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await expect(listMembers(db, f.courier)).rejects.toThrow("FORBIDDEN");
    await expect(grantRole(db, f.dispatcher, {
      userId: f.courierId, role: "dispatcher", reason: "test", key: `grant-${rid()}`,
    })).rejects.toThrow("FORBIDDEN");
  });

  it("grants and revokes a role with an audit trail", async () => {
    const f = await orgWithAdmin();
    const targetId = await seedUser(db, f.organizationId);
    await db.insert(memberships).values({ organizationId: f.organizationId, userId: targetId });

    await grantRole(db, f.admin, { userId: targetId, role: "customer_support", reason: "новая смена", key: `grant-${rid()}` });
    expect((await memberRoles(db, f.admin, targetId)).map(row => row.role)).toContain("customer_support");

    const members = await listMembers(db, f.admin);
    const target = members.find(row => row.userId === targetId);
    expect(target?.roles).toContain("customer_support");

    await revokeRole(db, f.admin, { userId: targetId, role: "customer_support", reason: "смена закрыта", key: `revoke-${rid()}` });
    expect((await memberRoles(db, f.admin, targetId)).map(row => row.role)).not.toContain("customer_support");

    const audit = await listAuditEvents(db, f.admin);
    const actions = audit.map(row => row.action);
    expect(actions).toContain("admin.role_granted");
    expect(actions).toContain("admin.role_revoked");
  });

  it("forbids self-admin grant and removing the last admin", async () => {
    const f = await orgWithAdmin();
    await expect(grantRole(db, f.admin, {
      userId: f.admin.userId, role: "platform_admin", reason: "себе", key: `grant-${rid()}`,
    })).rejects.toThrow("SELF_ROLE_GRANT");

    await expect(revokeRole(db, f.admin, {
      userId: f.admin.userId, role: "platform_admin", reason: "последний", key: `revoke-${rid()}`,
    })).rejects.toThrow("LAST_ADMIN");
  });

  it("revokes a session so its token stops resolving", async () => {
    const f = await orgWithAdmin();
    const token = `tok-${rid()}`;
    const [session] = await db.insert(sessions).values({
      userId: f.admin.userId,
      organizationId: f.organizationId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning();
    expect((await principalFromToken(db, token, "req")).userId).toBe(f.admin.userId);

    await revokeSession(db, f.admin, { sessionId: session.id, reason: "потерян телефон", key: `revoke-${rid()}` });
    await expect(principalFromToken(db, token, "req")).rejects.toThrow("UNAUTHORIZED");

    const [stored] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(stored.revokedAt).toBeTruthy();
  });

  it("builds a review queue from claims, refunds, devices, partials and cancels", async () => {
    const f = await orgWithAdmin();
    const customerId = f.principal.userId;

    for (let index = 0; index < 3; index += 1) {
      await db.insert(claims).values({
        organizationId: f.organizationId,
        orderId: f.orderId,
        openedBy: customerId,
        claimType: "damage",
        description: `повтор ${index}`,
      });
    }

    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const invoice = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });
    const capture = await capturePayment(db, finance, {
      orderId: f.orderId, amountKopeks: invoice.totalKopeks, key: `cap-${rid()}`,
    });
    await refundPayment(db, finance, {
      paymentIntentId: capture.paymentIntentId, amountKopeks: 100, reason: "жест доброй воли", key: `ref-${rid()}`,
    });

    const deviceId = rid();
    for (const actorId of [f.courierId, await seedUser(db, f.organizationId)]) {
      await db.insert(scanEvents).values({
        organizationId: f.organizationId,
        deviceId,
        clientEventId: rid(),
        actorId,
        scannedType: "order",
        scannedId: f.orderId,
        capturedAt: new Date(),
        payloadHash: "hash",
      });
    }

    const [address] = await db.select({ id: customerAddresses.id }).from(customerAddresses).where(and(
      eq(customerAddresses.organizationId, f.organizationId),
      eq(customerAddresses.customerId, customerId),
      eq(customerAddresses.buildingId, f.buildingId),
    )).limit(1);
    expect(address).toBeDefined();

    const [partialOrder] = await db.insert(orders).values({
      organizationId: f.organizationId,
      customerId,
      addressId: address.id,
      quoteId: f.quoteId,
      publicNumber: `PARTIAL-${rid()}`,
      lifecycleState: "out_for_delivery",
      termsVersion: f.catalog.termsVersion,
      acceptedQuoteHash: "a".repeat(64),
    }).returning();
    for (let index = 0; index < 2; index += 1) {
      await db.insert(deliveryAttempts).values({
        organizationId: f.organizationId,
        stopId: f.stopId,
        orderId: partialOrder.id,
        outcome: "partial",
        deliveredGarmentIds: [],
        recipientProofJson: { method: "code" },
        actorId: f.courierId,
      });
    }

    for (let index = 0; index < 3; index += 1) {
      await db.insert(orders).values({
        organizationId: f.organizationId,
        customerId,
        addressId: address.id,
        quoteId: f.quoteId,
        publicNumber: `CANCEL-${rid()}`,
        lifecycleState: "cancelled",
        termsVersion: f.catalog.termsVersion,
        acceptedQuoteHash: "b".repeat(64),
      });
    }

    const signals = await fraudSignals(db, f.admin);
    const kinds = new Set(signals.map(signal => signal.kind));
    expect(kinds).toContain("claim_velocity");
    expect(kinds).toContain("refund_without_delivery");
    expect(kinds).toContain("shared_devices");
    expect(kinds).toContain("repeated_partial_delivery");
    expect(kinds).toContain("cancel_velocity");
    expect(signals.every(signal => signal.recommendation === "manual_review")).toBe(true);
  });

  it("never returns another tenant's signals or members", async () => {
    const own = await orgWithAdmin();
    const foreign = await seedFullOrder(db, { state: "scheduled" });
    await db.insert(claims).values({
      organizationId: foreign.organizationId, orderId: foreign.orderId,
      openedBy: foreign.principal.userId, claimType: "damage", description: "чужое",
    });

    const signals = await fraudSignals(db, own.admin);
    expect(signals.some(signal => signal.subjectId === foreign.principal.userId)).toBe(false);
    const members = await listMembers(db, own.admin);
    const foreignMemberships = await db.select().from(memberships).where(and(
      eq(memberships.organizationId, foreign.organizationId),
    ));
    const ownUserIds = new Set(members.map(row => row.userId));
    expect(foreignMemberships.some(row => ownUserIds.has(row.userId))).toBe(false);
  });
});
