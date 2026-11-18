import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  custodyEvents, evidenceAccessEvents, evidenceAssets, evidenceLegalHolds,
  membershipRoles, memberships, orders, partners, users,
} from "../../src/db/schema.js";
import type { Principal } from "../../src/core/context.js";
import { makePrincipal, seedAddress } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { createQuote } from "../../src/services/quotes.js";
import { createOrder } from "../../src/services/orders.js";
import { openClaim } from "../../src/services/claims.js";
import { assignOrderToPartner } from "../../src/services/partner.js";
import { deleteEvidence, listEvidence, readEvidence, registerEvidence } from "../../src/services/workspace.js";

const rid = () => randomUUID();
const sha = (char: string) => char.repeat(64);

describe.skipIf(!process.env.TEST_DATABASE_URL)("Lane D evidence ABAC", () => {
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
    return { cookie: String(response.headers["set-cookie"] ?? "").split(";")[0] };
  }

  /** A partner user with a known phone, so the API session carries the partner scope. */
  async function seedPartnerUser(organizationId: string, phone: string) {
    const [partner] = await db.insert(partners).values({ organizationId, name: `Прачечная ${rid().slice(0, 6)}` }).returning();
    const [user] = await db.insert(users).values({ phone }).returning();
    const [membership] = await db.insert(memberships).values({
      organizationId, userId: user.id, partnerId: partner.id,
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: membership.id, role: "laundry_operator" });
    return { partnerId: partner.id, userId: user.id, phone };
  }

  async function placeOrder(f: Awaited<ReturnType<typeof seedFullOrder>>, principal: Principal) {
    const quote = await createQuote(db, principal, {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `quote-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    return createOrder(db, principal, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: f.catalog.termsVersion,
      key: `order-${rid()}`,
    });
  }

  /**
   * One tenant with two customers (each with an order of their own) and two laundry partners.
   * The second tenant exists to prove that tenant isolation is not accidental.
   */
  async function scenario() {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const organizationId = f.organizationId;

    const customerA = makePrincipal(organizationId, f.userId, ["customer"]);
    const customerAPhone = f.phone;

    const phoneB = `+7999${Math.floor(Math.random() * 1e8)}`;
    const [userB] = await db.insert(users).values({ phone: phoneB }).returning();
    await seedAddress(db, organizationId, userB.id, f.buildingId);
    const customerB = makePrincipal(organizationId, userB.id, ["customer"]);
    const orderB = await placeOrder(f, customerB);

    const claimB = await openClaim(db, customerB, {
      orderId: orderB.id, claimType: "damage", description: "пятно на изделии", key: `claim-${rid()}`,
    });
    const [custodyEventB] = await db.insert(custodyEvents).values({
      organizationId,
      orderId: orderB.id,
      fromParty: "courier",
      toParty: "laundry_operator",
      actorId: f.courierId,
      manifestHash: sha("f"),
    }).returning();

    const partnerA = await seedPartnerUser(organizationId, `+7999${Math.floor(Math.random() * 1e8)}`);
    const partnerB = await seedPartnerUser(organizationId, `+7999${Math.floor(Math.random() * 1e8)}`);
    // Custody of customer A's order goes to partner B only.
    await assignOrderToPartner(db, f.dispatcher, {
      orderId: f.orderId, partnerId: partnerB.partnerId, key: `assign-${rid()}`,
    });

    const orderKey = `evidence/${rid()}.jpg`;
    const claimKey = `evidence/${rid()}.jpg`;
    const custodyKey = `evidence/${rid()}.jpg`;
    const orderEvidence = await registerEvidence(db, customerA, {
      ownerType: "order", ownerId: f.orderId, objectKey: orderKey, sha256: sha("a"),
      purpose: "intake_condition", key: `ev-${rid()}`,
    });
    const claimEvidence = await registerEvidence(db, customerB, {
      ownerType: "claim", ownerId: claimB.claimId, objectKey: claimKey, sha256: sha("b"),
      purpose: "claim_evidence", key: `ev-${rid()}`,
    });
    const custodyEvidence = await registerEvidence(db, customerB, {
      ownerType: "custody_event", ownerId: custodyEventB.id, objectKey: custodyKey, sha256: sha("c"),
      purpose: "intake_condition", key: `ev-${rid()}`,
    });

    const other = await seedFullOrder(db, { state: "scheduled" });

    return {
      f, organizationId, customerA, customerAPhone, customerB, phoneB, orderB, claimB,
      custodyEventB, partnerA, partnerB, orderKey, claimKey, custodyKey,
      orderEvidence, claimEvidence, custodyEvidence, other,
    };
  }

  it("a customer cannot list another customer's claim evidence", async () => {
    const s = await scenario();
    const session = await login(s.organizationId, s.customerAPhone, ["customer"]);

    const listed = await app.inject({
      method: "GET", url: `/api/v1/evidence/claim/${s.claimB.claimId}`, headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(404);
    expect(listed.json().error.code).toBe("NOT_FOUND");
    expect(listed.body).not.toContain(s.claimKey);
    expect(listed.body).not.toContain(s.claimEvidence.evidenceId);
  });

  it("a customer cannot list another customer's custody event evidence", async () => {
    const s = await scenario();
    const session = await login(s.organizationId, s.customerAPhone, ["customer"]);

    const listed = await app.inject({
      method: "GET", url: `/api/v1/evidence/custody_event/${s.custodyEventB.id}`, headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(404);
    expect(listed.json().error.code).toBe("NOT_FOUND");
    expect(listed.body).not.toContain(s.custodyKey);
    expect(listed.body).not.toContain(s.custodyEvidence.evidenceId);
  });

  it("a customer cannot read a specific evidence id that belongs to another customer", async () => {
    const s = await scenario();

    await expect(readEvidence(db, s.customerA, s.claimEvidence.evidenceId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidence(db, s.customerA, s.custodyEvidence.evidenceId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteEvidence(db, s.customerA, { evidenceId: s.claimEvidence.evidenceId, key: `del-${rid()}` }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    // The foreign evidence is untouched.
    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, s.claimEvidence.evidenceId));
    expect(asset.status).toBe("pending_upload");
  });

  it("a laundry partner cannot read the evidence of an order assigned to another partner", async () => {
    const s = await scenario();
    const stranger = await login(s.organizationId, s.partnerA.phone, ["laundry_operator"], s.partnerA.partnerId);

    const denied = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: stranger.cookie },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe("NOT_FOUND");
    expect(denied.body).not.toContain(s.orderKey);

    // The partner that holds custody of the order is entitled to the same listing.
    const assigned = await login(s.organizationId, s.partnerB.phone, ["laundry_operator"], s.partnerB.partnerId);
    const allowed = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: assigned.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).not.toContain(s.orderKey);
  });

  it("a user of another tenant is denied", async () => {
    const s = await scenario();
    const foreign = await login(s.other.organizationId, s.other.phone, ["customer"]);

    const listed = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: foreign.cookie },
    });
    expect(listed.statusCode).toBe(404);
    expect(listed.json().error.code).toBe("NOT_FOUND");
    expect(listed.body).not.toContain(s.orderKey);
    expect(listed.body).not.toContain(s.orderEvidence.evidenceId);
  });

  it("the storage key never appears in a customer or partner listing", async () => {
    const s = await scenario();
    const owner = await login(s.organizationId, s.customerAPhone, ["customer"]);
    const assigned = await login(s.organizationId, s.partnerB.phone, ["laundry_operator"], s.partnerB.partnerId);

    const customerListing = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: owner.cookie },
    });
    expect(customerListing.statusCode).toBe(200);
    expect(customerListing.body).not.toContain(s.orderKey);
    expect(customerListing.body).not.toContain("objectKey");

    const partnerListing = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: assigned.cookie },
    });
    expect(partnerListing.statusCode).toBe(200);
    expect(partnerListing.body).not.toContain(s.orderKey);
    expect(partnerListing.body).not.toContain("objectKey");
  });

  it("an unauthenticated evidence request is rejected", async () => {
    const s = await scenario();

    const listed = await app.inject({ method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}` });
    expect(listed.statusCode).toBe(401);
    expect(listed.json().error.code).toBe("UNAUTHORIZED");
  });

  it("the owner lists their own evidence", async () => {
    const s = await scenario();
    const session = await login(s.organizationId, s.customerAPhone, ["customer"]);

    const listed = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as Array<{ id: string; sha256: string }>;
    expect(body.map(row => row.id)).toEqual([s.orderEvidence.evidenceId]);
    expect(body[0].sha256).toBe(sha("a"));
  });

  it("the owner deletes their own evidence and the audit history survives", async () => {
    const s = await scenario();
    const session = await login(s.organizationId, s.customerAPhone, ["customer"]);
    await app.inject({ method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: session.cookie } });

    const deleted = await deleteEvidence(db, s.customerA, { evidenceId: s.orderEvidence.evidenceId, key: `del-${rid()}` });
    expect(deleted.deleted).toBe(true);

    // The asset is tombstoned, not erased, and its access events are kept.
    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, s.orderEvidence.evidenceId));
    expect(asset).toBeDefined();
    expect(asset.status).toBe("expired");
    const access = await db.select().from(evidenceAccessEvents)
      .where(eq(evidenceAccessEvents.assetId, s.orderEvidence.evidenceId));
    expect(access.length).toBeGreaterThan(0);

    // A tombstoned asset is no longer served.
    const after = await app.inject({
      method: "GET", url: `/api/v1/evidence/order/${s.f.orderId}`, headers: { cookie: session.cookie },
    });
    expect(after.json()).toEqual([]);
  });

  it("evidence under an active legal hold cannot be deleted", async () => {
    const s = await scenario();
    await db.insert(evidenceLegalHolds).values({
      organizationId: s.organizationId,
      assetId: s.claimEvidence.evidenceId,
      claimId: s.claimB.claimId,
      reason: "claim hold",
      placedBy: s.customerB.userId,
    });

    await expect(deleteEvidence(db, s.customerB, { evidenceId: s.claimEvidence.evidenceId, key: `del-${rid()}` }))
      .rejects.toMatchObject({ code: "FINANCIAL_HOLD" });

    // The asset stays under legal hold and the hold record itself is preserved.
    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, s.claimEvidence.evidenceId));
    expect(asset.status).toBe("legal_hold");
    expect(asset.legalHoldCount).toBe(1);
    const holds = await db.select().from(evidenceLegalHolds)
      .where(eq(evidenceLegalHolds.assetId, s.claimEvidence.evidenceId));
    expect(holds).toHaveLength(1);
  });

  it("evidence registration for a foreign owner is refused", async () => {
    const s = await scenario();

    await expect(registerEvidence(db, s.customerA, {
      ownerType: "claim", ownerId: s.claimB.claimId, objectKey: `evidence/${rid()}.jpg`, sha256: sha("d"),
      purpose: "claim_evidence", key: `ev-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(registerEvidence(db, s.customerA, {
      ownerType: "custody_event", ownerId: s.custodyEventB.id, objectKey: `evidence/${rid()}.jpg`, sha256: sha("d"),
      purpose: "intake_condition", key: `ev-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an owner type without a resolved rule is denied", async () => {
    const s = await scenario();

    await expect(listEvidence(db, s.customerA, "garment", s.f.orderId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listEvidence(db, s.customerA, "order", rid()))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a customer of another tenant cannot delete evidence", async () => {
    const s = await scenario();
    const foreign = makePrincipal(s.other.organizationId, s.other.userId, ["customer"]);

    await expect(deleteEvidence(db, foreign, { evidenceId: s.orderEvidence.evidenceId, key: `del-${rid()}` }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, s.orderEvidence.evidenceId));
    expect(asset.status).toBe("pending_upload");
    const [order] = await db.select().from(orders).where(eq(orders.id, s.f.orderId));
    expect(order.assignedPartnerId).toBe(s.partnerB.partnerId);
  });
});
