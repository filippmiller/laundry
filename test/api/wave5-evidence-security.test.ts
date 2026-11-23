import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { Pool } from "pg";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  customerAddresses, evidenceAssets, evidenceLegalHolds, outboxEvents,
} from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { addAddress, removeAddress } from "../../src/services/customer.js";
import { decideClaim, openClaim, reopenClaim } from "../../src/services/claims.js";
import { deleteEvidence, registerEvidence, uploadEvidence } from "../../src/services/workspace.js";

const rid = () => randomUUID();
const sha256Hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

async function waitForLockWaiter(pool: Pool, relationName: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await pool.query(
      `SELECT 1
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND query ILIKE $1
       LIMIT 1`,
      [`%${relationName}%`],
    );
    if (res.rowCount && res.rowCount > 0) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for lock waiter on ${relationName}`);
}

async function expectTriggerError(work: Promise<unknown>, expectedText: string): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  const causeMessage = caught && typeof caught === "object" && "cause" in caught && (caught as { cause?: unknown }).cause instanceof Error
    ? ((caught as { cause: Error }).cause.message)
    : "";
  expect(`${message}\n${causeMessage}`).toContain(expectedText);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 5 Track C: Evidence Preservation, Concurrency & Privacy", () => {
  let db: Db;
  let pool: Pool;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 12 });
    db = created.db;
    pool = created.pool;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function login(organizationId: string, phone: string, roles: string[]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
      userId: (response.json() as { userId: string }).userId,
    };
  }

  it("LND-PRO-009 + LND-PRO-006: direct claim attachment auto-holds on verification, releases on decision (with orderId in event), and re-holds on reopen", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);

    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Прямое вложение к претензии",
      key: `claim-${rid()}`,
    });

    // 1. Register direct claim attachment -> stays pending_upload with NO hold yet.
    const directBytes1 = Buffer.from(`direct-claim-1-${rid()}`);
    const reg1 = await registerEvidence(db, f.principal, {
      ownerType: "claim",
      ownerId: claim.claimId,
      objectKey: `claims/${claim.claimId}/${rid()}.jpg`,
      sha256: sha256Hex(directBytes1),
      purpose: "claim_evidence",
      mimeType: "image/jpeg",
      sizeBytes: directBytes1.byteLength,
      key: `reg-direct-1-${rid()}`,
    });
    expect(reg1.status).toBe("pending_upload");

    // Second pending upload registered while claim is active; we'll verify it AFTER decision.
    const directBytes2 = Buffer.from(`direct-claim-2-${rid()}`);
    const reg2 = await registerEvidence(db, f.principal, {
      ownerType: "claim",
      ownerId: claim.claimId,
      objectKey: `claims/${claim.claimId}/${rid()}.jpg`,
      sha256: sha256Hex(directBytes2),
      purpose: "claim_evidence",
      mimeType: "image/jpeg",
      sizeBytes: directBytes2.byteLength,
      key: `reg-direct-2-${rid()}`,
    });

    const preUploadHolds = await db.select().from(evidenceLegalHolds).where(eq(evidenceLegalHolds.assetId, reg1.evidenceId));
    expect(preUploadHolds).toHaveLength(0);

    // 2. Upload & verify reg1 while claim is active -> automatically placed on legal hold.
    const up1 = await uploadEvidence(db, f.principal, {
      evidenceId: reg1.evidenceId,
      bytes: directBytes1,
      mimeType: "image/jpeg",
      key: `up-direct-1-${rid()}`,
    });
    expect(up1.status).toBe("legal_hold");

    let [asset1] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg1.evidenceId));
    expect(asset1.status).toBe("legal_hold");
    expect(asset1.legalHoldCount).toBe(1);

    const activeHolds1 = await db.select().from(evidenceLegalHolds).where(and(
      eq(evidenceLegalHolds.assetId, reg1.evidenceId),
      eq(evidenceLegalHolds.claimId, claim.claimId),
      isNull(evidenceLegalHolds.releasedAt),
    ));
    expect(activeHolds1).toHaveLength(1);
    expect(activeHolds1[0].placedBy).toBe(f.principal.userId);
    expect(activeHolds1[0].organizationId).toBe(f.organizationId);

    // Held direct claim attachment cannot be deleted while claim is active.
    await expect(deleteEvidence(db, f.principal, {
      evidenceId: reg1.evidenceId,
      key: `del-held-${rid()}`,
    })).rejects.toMatchObject({ code: "FINANCIAL_HOLD" });

    // 3. Decide claim -> releases hold and records orderId in claim.decided outbox event.
    const decided = await decideClaim(db, approver, {
      claimId: claim.claimId,
      outcome: "denied_with_reason",
      rationale: "Повреждение не подтверждено первичным осмотром",
      key: `dec-${rid()}`,
    });
    expect(decided.releasedHoldCount).toBe(1);

    [asset1] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg1.evidenceId));
    expect(asset1.status).toBe("retained");
    expect(asset1.legalHoldCount).toBe(0);

    const [decidedEvent] = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "claim"),
      eq(outboxEvents.aggregateId, claim.claimId),
      eq(outboxEvents.eventType, "claim.decided"),
    ));
    expect(decidedEvent).toBeDefined();
    expect((decidedEvent.payloadJson as Record<string, unknown>).orderId).toBe(f.orderId);

    // 4. Pending upload reg2 remains uploadable after decision, transitioning to verified without hold.
    const up2 = await uploadEvidence(db, f.principal, {
      evidenceId: reg2.evidenceId,
      bytes: directBytes2,
      mimeType: "image/jpeg",
      key: `up-direct-2-${rid()}`,
    });
    expect(up2.status).toBe("verified");
    const [asset2BeforeReopen] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg2.evidenceId));
    expect(asset2BeforeReopen.status).toBe("verified");
    expect(asset2BeforeReopen.legalHoldCount).toBe(0);

    // 5. Reopen claim -> re-places legal holds on BOTH previously held reg1 AND direct attachment reg2!
    const reopened = await reopenClaim(db, support, {
      claimId: claim.claimId,
      reason: "Клиент предоставил дополнительные доказательства",
      key: `reopen-${rid()}`,
    });
    expect(reopened.state).toBe("reopened");
    expect(reopened.reheldCount).toBe(2);

    [asset1] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg1.evidenceId));
    const [asset2] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg2.evidenceId));
    expect(asset1.status).toBe("legal_hold");
    expect(asset1.legalHoldCount).toBe(1);
    expect(asset2.status).toBe("legal_hold");
    expect(asset2.legalHoldCount).toBe(1);
  });

  it("LND-PRO-012: cross-customer and cross-tenant removeAddress on in-use address returns uniform NOT_FOUND with zero orderId leak", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [orderRow] = await db.select({ addressId: customerAddresses.id })
      .from(customerAddresses)
      .where(and(
        eq(customerAddresses.organizationId, f.organizationId),
        eq(customerAddresses.customerId, f.userId),
      ))
      .limit(1);
    expect(orderRow).toBeDefined();
    const inUseAddressId = orderRow.addressId;

    // Same-tenant different customer
    const otherPhone = `+7999${Math.floor(1e7 + Math.random() * 8e7)}`;
    const otherSession = await login(f.organizationId, otherPhone, ["customer"]);
    const crossCustomerRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/addresses/${inUseAddressId}`,
      headers: { cookie: otherSession.cookie, "idempotency-key": `rm-cross-cust-${rid()}` },
    });
    expect(crossCustomerRes.statusCode).toBe(404);
    expect(crossCustomerRes.json().error.code).toBe("NOT_FOUND");
    expect(crossCustomerRes.body).not.toContain(f.orderId);
    expect(crossCustomerRes.body).not.toContain("ADDRESS_IN_USE");

    // Cross-tenant customer
    const otherTenant = await seedFullOrder(db, { state: "scheduled" });
    const otherTenantSession = await login(otherTenant.organizationId, otherTenant.phone, ["customer"]);
    const crossTenantRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/addresses/${inUseAddressId}`,
      headers: { cookie: otherTenantSession.cookie, "idempotency-key": `rm-cross-org-${rid()}` },
    });
    expect(crossTenantRes.statusCode).toBe(404);
    expect(crossTenantRes.json().error.code).toBe("NOT_FOUND");
    expect(crossTenantRes.body).not.toContain(f.orderId);
    expect(crossTenantRes.body).not.toContain("ADDRESS_IN_USE");

    // Owner deleting their own in-use address gets 409 ADDRESS_IN_USE with orderId
    const ownerSession = await login(f.organizationId, f.phone, ["customer"]);
    const ownerInUseRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/addresses/${inUseAddressId}`,
      headers: { cookie: ownerSession.cookie, "idempotency-key": `rm-own-used-${rid()}` },
    });
    expect(ownerInUseRes.statusCode).toBe(409);
    expect(ownerInUseRes.json().error.message).toBe("ADDRESS_IN_USE");
    expect(ownerInUseRes.json().error.details.orderId).toBe(f.orderId);

    // Owner deleting their own unused address succeeds
    const extra = await addAddress(db, f.principal, {
      buildingId: f.buildingId,
      apartment: "42",
      key: `add-unused-${rid()}`,
    });
    const removed = await removeAddress(db, f.principal, extra.addressId);
    expect(removed).toMatchObject({ addressId: extra.addressId, removed: true });
  });

  it("LND-PRO-013: DB trigger blocks legal holds on tombstoned/expired assets while preserving pending_upload compatibility", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const bytes1 = Buffer.from(`tombstone-guard-1-${rid()}`);
    const bytes2 = Buffer.from(`tombstone-guard-2-${rid()}`);

    const regDeleted = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256: sha256Hex(bytes1),
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      key: `reg-del-${rid()}`,
    });
    await uploadEvidence(db, f.principal, {
      evidenceId: regDeleted.evidenceId,
      bytes: bytes1,
      mimeType: "image/jpeg",
      key: `up-del-${rid()}`,
    });
    await deleteEvidence(db, f.principal, {
      evidenceId: regDeleted.evidenceId,
      key: `del-asset-${rid()}`,
    });

    await expectTriggerError(
      db.insert(evidenceLegalHolds).values({
        organizationId: f.organizationId,
        assetId: regDeleted.evidenceId,
        reason: "illegal hold on deleted asset",
        placedBy: f.userId,
      }),
      "EVIDENCE_NOT_ELIGIBLE_FOR_LEGAL_HOLD",
    );

    const regExpired = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256: sha256Hex(bytes2),
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      key: `reg-exp-${rid()}`,
    });
    await db.update(evidenceAssets).set({ status: "expired" }).where(eq(evidenceAssets.id, regExpired.evidenceId));

    await expectTriggerError(
      db.insert(evidenceLegalHolds).values({
        organizationId: f.organizationId,
        assetId: regExpired.evidenceId,
        reason: "illegal hold on expired asset",
        placedBy: f.userId,
      }),
      "EVIDENCE_NOT_ELIGIBLE_FOR_LEGAL_HOLD",
    );

    // Pending upload remains compatible with direct legal hold inserts.
    const regPending = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256: sha256Hex(Buffer.from(`pending-${rid()}`)),
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      key: `reg-pend-${rid()}`,
    });
    await db.insert(evidenceLegalHolds).values({
      organizationId: f.organizationId,
      assetId: regPending.evidenceId,
      reason: "pending upload compatibility",
      placedBy: f.userId,
    });
    const [pendingAsset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, regPending.evidenceId));
    expect(pendingAsset.status).toBe("legal_hold");
    expect(pendingAsset.legalHoldCount).toBe(1);
  });

  it("LND-PRO-013: deterministic lock serialization and concurrent openClaim vs deleteEvidence never leave an active hold on a deleted asset", async () => {
    // 1. Deterministic lock-waiter test: tx holds FOR UPDATE and tombstones asset while openClaim waits.
    const f1 = await seedFullOrder(db, { state: "scheduled" });
    const bytes = Buffer.from(`race-lock-${rid()}`);
    const reg = await registerEvidence(db, f1.principal, {
      ownerType: "order",
      ownerId: f1.orderId,
      objectKey: `orders/${f1.orderId}/${rid()}.jpg`,
      sha256: sha256Hex(bytes),
      purpose: "claim_evidence",
      mimeType: "image/jpeg",
      key: `reg-lock-${rid()}`,
    });
    await uploadEvidence(db, f1.principal, {
      evidenceId: reg.evidenceId,
      bytes,
      mimeType: "image/jpeg",
      key: `up-lock-${rid()}`,
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM evidence_assets WHERE id = $1 FOR UPDATE`, [reg.evidenceId]);
      await client.query(`UPDATE evidence_assets SET deleted_at = NOW() WHERE id = $1`, [reg.evidenceId]);

      const claimPromise = openClaim(db, f1.principal, {
        orderId: f1.orderId,
        claimType: "damage",
        description: "Гонка удаления и претензии",
        evidenceIds: [reg.evidenceId],
        key: `claim-lock-${rid()}`,
      });
      await waitForLockWaiter(pool, "evidence_assets");
      await client.query("COMMIT");

      await expect(claimPromise).rejects.toMatchObject({ code: "NOT_FOUND" });
      const holdsAfter = await db.select().from(evidenceLegalHolds).where(eq(evidenceLegalHolds.assetId, reg.evidenceId));
      expect(holdsAfter).toHaveLength(0);
    } finally {
      client.release();
    }

    // 2. Live concurrent Promise.allSettled rounds between openClaim and deleteEvidence.
    for (let i = 0; i < 6; i++) {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const b = Buffer.from(`race-round-${i}-${rid()}`);
      const r = await registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `orders/${f.orderId}/${rid()}.jpg`,
        sha256: sha256Hex(b),
        purpose: "claim_evidence",
        mimeType: "image/jpeg",
        key: `reg-r-${i}-${rid()}`,
      });
      await uploadEvidence(db, f.principal, {
        evidenceId: r.evidenceId,
        bytes: b,
        mimeType: "image/jpeg",
        key: `up-r-${i}-${rid()}`,
      });

      const [delRes, claimRes] = await Promise.allSettled([
        deleteEvidence(db, f.principal, { evidenceId: r.evidenceId, key: `del-r-${i}-${rid()}` }),
        openClaim(db, f.principal, {
          orderId: f.orderId,
          claimType: "damage",
          description: `Concurrent race ${i}`,
          evidenceIds: [r.evidenceId],
          key: `cl-r-${i}-${rid()}`,
        }),
      ]);

      const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, r.evidenceId));
      const activeHolds = await db.select().from(evidenceLegalHolds).where(and(
        eq(evidenceLegalHolds.assetId, r.evidenceId),
        isNull(evidenceLegalHolds.releasedAt),
      ));

      // Mutual exclusion invariant: never deleted + held at the same time.
      expect(asset.deletedAt !== null && activeHolds.length > 0).toBe(false);
      expect(asset.deletedAt !== null && asset.legalHoldCount > 0).toBe(false);
      if (delRes.status === "fulfilled") {
        expect(claimRes.status).toBe("rejected");
        expect(asset.deletedAt).not.toBeNull();
        expect(activeHolds).toHaveLength(0);
      } else {
        expect(claimRes.status).toBe("fulfilled");
        expect(asset.deletedAt).toBeNull();
        expect(asset.status).toBe("legal_hold");
        expect(asset.legalHoldCount).toBe(1);
        expect(activeHolds).toHaveLength(1);
      }
    }
  });
});
