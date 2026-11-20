import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  compensations, evidenceAccessEvents, evidenceAssets, membershipRoles, memberships, supportMessages, users,
} from "../../src/db/schema.js";
import type { Principal } from "../../src/core/context.js";
import { makePrincipal, seedAddress, seedUser } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { revokeRole, setMembershipState } from "../../src/services/admin.js";
import { decideClaim, openClaim } from "../../src/services/claims.js";
import { closeThread, getThread, openThread, postMessage } from "../../src/services/support.js";
import {
  decideCompensation, proposeCompensation, registerEvidence, uploadEvidence,
} from "../../src/services/workspace.js";
import { createQuote } from "../../src/services/quotes.js";
import { createOrder } from "../../src/services/orders.js";

const rid = () => randomUUID();
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3B admin, evidence, compensation, claims & support", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  let previousStorageDir: string | undefined;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    previousStorageDir = process.env.EVIDENCE_STORAGE_DIR;
    storageDir = await mkdtemp(join(tmpdir(), "laundry-wave3b-evidence-"));
    process.env.EVIDENCE_STORAGE_DIR = storageDir;

    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
    if (previousStorageDir === undefined) {
      delete process.env.EVIDENCE_STORAGE_DIR;
    } else {
      process.env.EVIDENCE_STORAGE_DIR = previousStorageDir;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  async function login(organizationId: string, phone: string, roles: string[]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles },
    });
    expect(response.statusCode).toBe(200);
    return { cookie: String(response.headers["set-cookie"] ?? "").split(";")[0] };
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

  it("[NEW-S02] 1 active admin + 1 suspended admin -> revoking active admin fails with LAST_ADMIN", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });

    const activeAdminId = await seedUser(db, f.organizationId);
    const [activeMembership] = await db.insert(memberships).values({
      organizationId: f.organizationId, userId: activeAdminId, state: "active",
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: activeMembership.id, role: "platform_admin" });

    const suspendedAdminId = await seedUser(db, f.organizationId);
    const [suspendedMembership] = await db.insert(memberships).values({
      organizationId: f.organizationId, userId: suspendedAdminId, state: "suspended",
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: suspendedMembership.id, role: "platform_admin" });

    const activeAdmin = makePrincipal(f.organizationId, activeAdminId, ["platform_admin"]);

    await expect(revokeRole(db, activeAdmin, {
      userId: activeAdminId, role: "platform_admin", reason: "attempt last active", key: `rev-${rid()}`,
    })).rejects.toThrow("LAST_ADMIN");

    // Revoking the already-suspended admin is allowed since 1 active admin remains.
    const suspendedRevoked = await revokeRole(db, activeAdmin, {
      userId: suspendedAdminId, role: "platform_admin", reason: "cleanup suspended", key: `rev-${rid()}`,
    });
    expect(suspendedRevoked.removed).toBe(true);

    // If a second active admin exists and suspends the first, suspending the remaining active admin fails with LAST_ADMIN.
    const secondAdminId = await seedUser(db, f.organizationId);
    const [secondMembership] = await db.insert(memberships).values({
      organizationId: f.organizationId, userId: secondAdminId, state: "active",
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: secondMembership.id, role: "platform_admin" });

    await setMembershipState(db, activeAdmin, {
      userId: secondAdminId, state: "suspended", reason: "suspend second", key: `state-${rid()}`,
    });
    await expect(revokeRole(db, activeAdmin, {
      userId: activeAdminId, role: "platform_admin", reason: "still only 1 active", key: `rev-${rid()}`,
    })).rejects.toThrow("LAST_ADMIN");
  });

  it("[NEW-S03] registerEvidence + uploadEvidence persists bytes and GET /api/v1/evidence/:id/content enforces ABAC", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const customerA = f.principal;

    const payloadBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const digest = sha256Hex(payloadBytes);

    const registered = await registerEvidence(db, customerA, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.png`,
      sha256: digest,
      purpose: "intake_condition",
      mimeType: "image/png",
      sizeBytes: payloadBytes.byteLength,
      key: `reg-${rid()}`,
    });

    const uploaded = await uploadEvidence(db, customerA, {
      evidenceId: registered.evidenceId,
      contentBase64: payloadBytes.toString("base64"),
      mimeType: "image/png",
      key: `upl-${rid()}`,
    });
    expect(uploaded.status).toBe("verified");

    const ownerSession = await login(f.organizationId, f.phone, ["customer"]);
    const ownerRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/${registered.evidenceId}/content`,
      headers: { cookie: ownerSession.cookie },
    });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.headers["content-type"]).toContain("image/png");
    expect(ownerRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(ownerRes.headers["cache-control"]).toBe("private, no-store");
    expect(ownerRes.rawPayload.equals(payloadBytes)).toBe(true);

    const accessEvents = await db.select().from(evidenceAccessEvents)
      .where(eq(evidenceAccessEvents.assetId, registered.evidenceId));
    expect(accessEvents.some(e => e.purpose === "content_download" && e.actorId === customerA.userId)).toBe(true);

    // Foreign customer in the same org gets 404.
    const foreignPhone = `+7999${Math.floor(1e7 + Math.random() * 8e7)}`;
    await db.insert(users).values({ phone: foreignPhone });
    const foreignSession = await login(f.organizationId, foreignPhone, ["customer"]);
    const foreignRes = await app.inject({
      method: "GET",
      url: `/api/v1/evidence/${registered.evidenceId}/content`,
      headers: { cookie: foreignSession.cookie },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(foreignRes.json().error.code).toBe("NOT_FOUND");

    // Verify DB asset status stayed verified.
    const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, registered.evidenceId));
    expect(asset.status).toBe("verified");
  });

  it("[Compensation race] once approved or paid, decideCompensation({ approve: false }) returns alreadyDecided and keeps state", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId, claimType: "damage", description: "повреждение ткани", key: `cl-${rid()}`,
    });
    await decideClaim(db, approver, {
      claimId: claim.claimId, outcome: "resolved", rationale: "Подтверждено повреждение на приёмке", key: `dec-${rid()}`,
    });

    const proposed = await proposeCompensation(db, support, {
      claimId: claim.claimId, amountKopeks: 50_000, key: `comp-prop-${rid()}`,
    });

    const approved = await decideCompensation(db, finance, {
      compensationId: proposed.compensationId, approve: true, key: `comp-app-${rid()}`,
    });
    expect(approved.state).toBe("approved");

    const lateDenyAfterApprove = await decideCompensation(db, finance, {
      compensationId: proposed.compensationId, approve: false, key: `comp-deny1-${rid()}`,
    });
    expect(lateDenyAfterApprove).toMatchObject({
      compensationId: proposed.compensationId,
      state: "approved",
      alreadyDecided: true,
    });

    const [rowAfterApprove] = await db.select().from(compensations).where(eq(compensations.id, proposed.compensationId));
    expect(rowAfterApprove.state).toBe("approved");

    // Also verify when compensation has already progressed to `paid`.
    await db.update(compensations).set({ state: "paid" }).where(eq(compensations.id, proposed.compensationId));
    const lateDenyAfterPaid = await decideCompensation(db, finance, {
      compensationId: proposed.compensationId, approve: false, key: `comp-deny2-${rid()}`,
    });
    expect(lateDenyAfterPaid).toMatchObject({
      compensationId: proposed.compensationId,
      state: "paid",
      alreadyDecided: true,
    });
    const [rowAfterPaid] = await db.select().from(compensations).where(eq(compensations.id, proposed.compensationId));
    expect(rowAfterPaid.state).toBe("paid");
  });

  it("[NEW-S04] support-opened claim on customer's order appears in customer's GET /api/v1/claims", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);

    const supportOpenedClaim = await openClaim(db, support, {
      orderId: f.orderId,
      claimType: "quality",
      description: "Претензия открыта поддержкой по обращению клиента",
      key: `claim-sup-${rid()}`,
    });

    // Another customer in the same org with their own claim must not leak into f.principal's list.
    const otherCustomerId = await seedUser(db, f.organizationId);
    await seedAddress(db, f.organizationId, otherCustomerId, f.buildingId);
    const otherCustomer = makePrincipal(f.organizationId, otherCustomerId, ["customer"]);
    const otherOrder = await placeOrder(f, otherCustomer);
    const otherClaim = await openClaim(db, otherCustomer, {
      orderId: otherOrder.id,
      claimType: "damage",
      description: "Чужая претензия другого клиента",
      key: `claim-other-${rid()}`,
    });

    const customerSession = await login(f.organizationId, f.phone, ["customer"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/claims",
      headers: { cookie: customerSession.cookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string }>;
    const ids = list.map(c => c.id);
    expect(ids).toContain(supportOpenedClaim.claimId);
    expect(ids).not.toContain(otherClaim.claimId);
  });

  it("[NEW-S05][NEW-S06] postMessage after closeThread fails with THREAD_CLOSED and getThread returns latest 500 messages", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);

    const thread = await openThread(db, f.principal, {
      orderId: f.orderId,
      subject: "Вопрос по заказу",
      body: "Сообщение #1",
      key: `thr-${rid()}`,
    });

    // Insert 504 more messages with monotonically increasing timestamps so total = 505 messages.
    const baseTime = Date.now() + 1_000;
    const bulk = Array.from({ length: 504 }, (_, idx) => ({
      threadId: thread.threadId,
      authorId: idx % 2 === 0 ? support.userId : f.principal.userId,
      body: `Сообщение #${idx + 2}`,
      createdAt: new Date(baseTime + idx * 10),
    }));
    await db.insert(supportMessages).values(bulk);

    const view = await getThread(db, f.principal, thread.threadId);
    expect(view.messages).toHaveLength(500);
    expect(view.messages[0]?.body).toBe("Сообщение #6");
    expect(view.messages[499]?.body).toBe("Сообщение #505");

    await closeThread(db, support, {
      threadId: thread.threadId, reason: "вопрос решён", key: `cls-${rid()}`,
    });

    await expect(postMessage(db, f.principal, {
      threadId: thread.threadId, body: "После закрытия", key: `msg-${rid()}`,
    })).rejects.toThrow("THREAD_CLOSED");
  });
});
