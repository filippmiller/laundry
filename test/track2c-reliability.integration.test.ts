import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import {
  buildings, compensations, evidenceAccessEvents, evidenceAssets, evidenceLegalHolds,
  ledgerJournals, orderLines, outboxEvents, partnerContracts, partnerCreditNotes, partnerInvoices, partnerPayouts,
  partners, partnerServiceAccruals, paymentEvents, paymentIntents,
} from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder } from "./operations-fixtures.js";
import { decideClaim, openClaim } from "../src/services/claims.js";
import {
  deleteEvidence, MAX_EVIDENCE_BYTES, proposeCompensation, decideCompensation,
  readEvidence, registerEvidence, runEvidenceRetentionSweep, uploadEvidence,
} from "../src/services/workspace.js";
import { createCustomerInvoice, handlePaymentWebhook } from "../src/services/finance.js";
import { processPaymentInbox } from "../src/services/payment-inbox.js";
import { computeOutboxBackoffMs, processOutbox, requeueFailedOutboxEvents } from "../src/services/outbox.js";
import { solveVrptwRoute } from "../src/services/routing.js";

const rid = () => randomUUID();
const sha256Hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Track 2C Reliability, Evidence, Outbox, Inbox, Routing & Finance/Privacy", () => {
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

  describe("lnd-ek8: Legal hold release trigger & claim decision", () => {
    it("releases legal hold on decideClaim and preserves hold while another overlapping claim is active", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
      const payload = Buffer.from("evidence-image-bytes-ek8");
      const digest = sha256Hex(payload);

      const reg = await registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `evidence/${rid()}.jpg`,
        sha256: digest,
        purpose: "intake_condition",
        mimeType: "image/jpeg",
        key: `reg-${rid()}`,
      });
      await uploadEvidence(db, f.principal, {
        evidenceId: reg.evidenceId,
        bytes: payload,
        mimeType: "image/jpeg",
        key: `up-${rid()}`,
      });

      // Claim 1 places legal hold -> count = 1, status = legal_hold
      const claim1 = await openClaim(db, f.principal, {
        orderId: f.orderId,
        claimType: "damage",
        description: "Первая претензия по повреждению вещи",
        evidenceIds: [reg.evidenceId],
        key: `claim1-${rid()}`,
      });
      let [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId));
      expect(asset.legalHoldCount).toBe(1);
      expect(asset.status).toBe("legal_hold");

      // Claim 2 places overlapping legal hold -> count = 2, status = legal_hold
      const claim2 = await openClaim(db, f.principal, {
        orderId: f.orderId,
        claimType: "missing",
        description: "Вторая перекрывающаяся претензия",
        evidenceIds: [reg.evidenceId],
        key: `claim2-${rid()}`,
      });
      [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId));
      expect(asset.legalHoldCount).toBe(2);
      expect(asset.status).toBe("legal_hold");

      // Decide claim 1 -> releases 1 hold -> count = 1, status STAYS legal_hold
      const dec1 = await decideClaim(db, approver, {
        claimId: claim1.claimId,
        outcome: "resolved",
        rationale: "Подтверждено и урегулировано по первой претензии",
        key: `dec1-${rid()}`,
      });
      expect(dec1.releasedHoldCount).toBe(1);
      [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId));
      expect(asset.legalHoldCount).toBe(1);
      expect(asset.status).toBe("legal_hold");

      // Decide claim 2 -> releases remaining hold -> count = 0, status transitions out of legal_hold to retained
      const dec2 = await decideClaim(db, approver, {
        claimId: claim2.claimId,
        outcome: "denied_with_reason",
        rationale: "Отклонено с обоснованием по второй претензии",
        key: `dec2-${rid()}`,
      });
      expect(dec2.releasedHoldCount).toBe(1);
      [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId));
      expect(asset.legalHoldCount).toBe(0);
      expect(asset.status).toBe("retained");

      const holds = await db.select().from(evidenceLegalHolds).where(eq(evidenceLegalHolds.assetId, reg.evidenceId));
      expect(holds).toHaveLength(2);
      expect(holds.every(h => h.releasedAt !== null)).toBe(true);
    });
  });

  describe("lnd-ikt: Evidence upload verification, tombstone & retention sweep", () => {
    it("enforces SHA-256, MIME allowlist, size limit, verified-only reads, legal-hold refusal, and retention sweep", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const session = await login(f.organizationId, f.phone, ["customer"]);

      // Disallowed MIME rejected on registration
      await expect(registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `evidence/${rid()}.exe`,
        sha256: "a".repeat(64),
        purpose: "intake_condition",
        mimeType: "application/x-msdownload",
        key: `bad-mime-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "EVIDENCE_MIME_NOT_ALLOWED" });

      // Oversize rejected on registration
      await expect(registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `evidence/${rid()}.jpg`,
        sha256: "a".repeat(64),
        purpose: "intake_condition",
        mimeType: "image/jpeg",
        sizeBytes: MAX_EVIDENCE_BYTES + 1,
        key: `oversize-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "EVIDENCE_SIZE_INVALID" });

      // Register valid asset
      const goodBytes = Buffer.from("real-jpeg-content-12345");
      const goodHash = sha256Hex(goodBytes);
      const reg = await registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `evidence/${rid()}.jpg`,
        sha256: goodHash,
        purpose: "intake_condition",
        mimeType: "image/jpeg",
        key: `good-reg-${rid()}`,
      });

      // Unverified asset cannot be served on readEvidence
      await expect(readEvidence(db, f.principal, reg.evidenceId))
        .rejects.toMatchObject({ code: "FORBIDDEN", message: "EVIDENCE_NOT_VERIFIED" });

      // Hash mismatch rejected via HTTP upload endpoint
      const badUpload = await app.inject({
        method: "POST",
        url: `/api/v1/evidence/${reg.evidenceId}/upload`,
        headers: { cookie: session.cookie, "idempotency-key": `bad-up-${rid()}` },
        payload: { contentBase64: Buffer.from("wrong-bytes").toString("base64"), mimeType: "image/jpeg" },
      });
      expect(badUpload.statusCode).toBe(400);
      expect(badUpload.json().error.message).toBe("EVIDENCE_SHA256_MISMATCH");

      // Disallowed MIME rejected on upload
      const badMimeUpload = await app.inject({
        method: "POST",
        url: `/api/v1/evidence/${reg.evidenceId}/upload`,
        headers: { cookie: session.cookie, "idempotency-key": `bad-mime-up-${rid()}` },
        payload: { contentBase64: goodBytes.toString("base64"), mimeType: "text/html" },
      });
      expect(badMimeUpload.statusCode).toBe(400);
      expect(badMimeUpload.json().error.message).toBe("EVIDENCE_MIME_NOT_ALLOWED");

      // Valid upload transitions pending_upload -> verified
      const okUpload = await app.inject({
        method: "POST",
        url: `/api/v1/evidence/${reg.evidenceId}/upload`,
        headers: { cookie: session.cookie, "idempotency-key": `ok-up-${rid()}` },
        payload: { contentBase64: goodBytes.toString("base64"), mimeType: "image/jpeg" },
      });
      expect(okUpload.statusCode).toBe(200);
      expect(okUpload.json().status).toBe("verified");

      // Verified asset is readable and logs access event
      const readRes = await readEvidence(db, f.principal, reg.evidenceId);
      expect(readRes.status).toBe("verified");

      // Retention sweep skips held assets and expires unheld past-retention assets while preserving audit tables
      const heldBytes = Buffer.from("held-asset-bytes");
      const heldReg = await registerEvidence(db, f.principal, {
        ownerType: "order",
        ownerId: f.orderId,
        objectKey: `evidence/${rid()}.png`,
        sha256: sha256Hex(heldBytes),
        purpose: "intake_condition",
        mimeType: "image/png",
        key: `held-reg-${rid()}`,
      });
      await uploadEvidence(db, f.principal, {
        evidenceId: heldReg.evidenceId,
        bytes: heldBytes,
        mimeType: "image/png",
        key: `held-up-${rid()}`,
      });
      await db.insert(evidenceLegalHolds).values({
        organizationId: f.organizationId,
        assetId: heldReg.evidenceId,
        reason: "retention test hold",
        placedBy: f.principal.userId,
      });

      const pastDate = new Date(Date.now() - 60_000);
      await db.update(evidenceAssets).set({ retentionUntil: pastDate }).where(eq(evidenceAssets.id, reg.evidenceId));
      await db.update(evidenceAssets).set({ retentionUntil: pastDate }).where(eq(evidenceAssets.id, heldReg.evidenceId));

      // Legal hold blocks deleteEvidence with FINANCIAL_HOLD
      await expect(deleteEvidence(db, f.principal, { evidenceId: heldReg.evidenceId, key: `del-held-${rid()}` }))
        .rejects.toMatchObject({ code: "FINANCIAL_HOLD" });

      const sweepNow = new Date();
      const sweep = await runEvidenceRetentionSweep(db, sweepNow);
      expect(sweep.expiredIds).toContain(reg.evidenceId);
      expect(sweep.expiredIds).not.toContain(heldReg.evidenceId);

      const [expiredAsset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId));
      expect(expiredAsset.status).toBe("expired");
      expect(expiredAsset.deletedAt).not.toBeNull();

      const [stillHeld] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, heldReg.evidenceId));
      expect(stillHeld.status).toBe("legal_hold");
      expect(stillHeld.deletedAt).toBeNull();

      // Audit events survived the sweep
      const accessEvents = await db.select().from(evidenceAccessEvents).where(eq(evidenceAccessEvents.assetId, reg.evidenceId));
      expect(accessEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("lnd-pfj: Payment inbox per-event transaction isolation", () => {
    it("rolls back a mid-event failure completely while sibling events in the same batch succeed", async () => {
      const f1 = await seedFullOrder(db, { state: "scheduled" });
      const f2 = await seedFullOrder(db, { state: "scheduled" });
      const fin1 = makePrincipal(f1.organizationId, await seedUser(db, f1.organizationId), ["platform_finance"]);
      const fin2 = makePrincipal(f2.organizationId, await seedUser(db, f2.organizationId), ["platform_finance"]);
      const inv1 = await createCustomerInvoice(db, fin1, { orderId: f1.orderId, key: `inv1-${rid()}` });
      const inv2 = await createCustomerInvoice(db, fin2, { orderId: f2.orderId, key: `inv2-${rid()}` });

      const [intent1] = await db.insert(paymentIntents).values({
        organizationId: f1.organizationId,
        orderId: f1.orderId,
        provider: "fake",
        amountKopeks: inv1.totalKopeks,
        state: "pending",
        idempotencyKey: `pi1-${rid()}`,
      }).returning();
      const [intent2] = await db.insert(paymentIntents).values({
        organizationId: f2.organizationId,
        orderId: f2.orderId,
        provider: "fake",
        amountKopeks: inv2.totalKopeks,
        state: "pending",
        idempotencyKey: `pi2-${rid()}`,
      }).returning();

      const evt1Id = `evt-fail-${rid()}`;
      const evt2Id = `evt-ok-${rid()}`;
      await handlePaymentWebhook(db, {
        provider: "fake", providerEventId: evt1Id, eventType: "captured",
        payload: { organizationId: f1.organizationId, paymentIntentId: intent1.id },
      });
      await handlePaymentWebhook(db, {
        provider: "fake", providerEventId: evt2Id, eventType: "captured",
        payload: { organizationId: f2.organizationId, paymentIntentId: intent2.id },
      });

      const result = await processPaymentInbox(db, {
        limit: 200,
        afterApply: async (event) => {
          if (event.paymentIntentId === intent1.id) {
            throw new Error("SIMULATED_MID_EVENT_CRASH");
          }
        },
      });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.processed).toBeGreaterThanOrEqual(1);

      // Event 1: completely rolled back (intent stays pending, zero ledger journals posted), failure recorded
      const [storedIntent1] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent1.id));
      expect(storedIntent1.state).toBe("pending");
      const journals1 = await db.select().from(ledgerJournals).where(eq(ledgerJournals.sourceId, intent1.id));
      expect(journals1).toHaveLength(0);
      const [storedEvt1] = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, evt1Id));
      expect(storedEvt1.state).toBe("failed");
      expect(storedEvt1.error).toBe("SIMULATED_MID_EVENT_CRASH");
      expect(storedEvt1.attempts).toBe(1);

      // Event 2 (sibling in same batch): committed cleanly!
      const [storedIntent2] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent2.id));
      expect(storedIntent2.state).toBe("captured");
      const journals2 = await db.select().from(ledgerJournals).where(eq(ledgerJournals.sourceId, intent2.id));
      expect(journals2).toHaveLength(1);
      const [storedEvt2] = await db.select().from(paymentEvents).where(eq(paymentEvents.providerEventId, evt2Id));
      expect(storedEvt2.state).toBe("processed");
      expect(storedEvt2.error).toBeNull();
    });
  });

  describe("lnd-0g5: Outbox exponential backoff, DLQ & idempotent provider receipts", () => {
    it("enforces available_at backoff, dead-letters after max attempts, and records provider receipts idempotently", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      // Drain existing order events for this org first so our injected event is isolated
      await processOutbox(db, { limit: 500, organizationId: f.organizationId });

      const t0 = new Date("2026-11-20T00:00:00.000Z");
      const [row] = await db.insert(outboxEvents).values({
        organizationId: f.organizationId,
        aggregateType: "order",
        aggregateId: f.orderId,
        eventType: "order.confirmed",
        payloadJson: { orderId: f.orderId },
        availableAt: t0,
      }).returning();

      // Pause gate claims nothing
      const pausedRes = await processOutbox(db, { paused: true, now: t0, organizationId: f.organizationId });
      expect(pausedRes.claimed).toBe(0);
      expect(pausedRes.paused).toBe(true);

      // Attempt 1 fails -> state = failed, availableAt pushed into future by backoff
      let deliveryCalls = 0;
      const failDeliver = async () => {
        deliveryCalls += 1;
        throw new Error("PROVIDER_TIMEOUT");
      };
      await processOutbox(db, { organizationId: f.organizationId, now: t0, maxAttempts: 3, backoffBaseMs: 10_000, deliver: failDeliver });
      let [current] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id));
      expect(current.state).toBe("failed");
      expect(current.deliveryStatus).toBe("failed");
      expect(current.attempts).toBe(1);
      expect(current.availableAt.getTime()).toBe(t0.getTime() + computeOutboxBackoffMs(1, 10_000));

      // Re-arm preserves backoff; immediate processOutbox at t0 + 1s does NOT claim it!
      await requeueFailedOutboxEvents(db, { organizationId: f.organizationId, now: t0 });
      const premature = await processOutbox(db, {
        organizationId: f.organizationId,
        now: new Date(t0.getTime() + 1_000),
        maxAttempts: 3,
        deliver: failDeliver,
      });
      expect(premature.claimed).toBe(0);

      // Attempt 2 at t0 + 10s fails -> backoff doubles to 20s
      const t1 = new Date(t0.getTime() + 10_000);
      await processOutbox(db, { organizationId: f.organizationId, now: t1, maxAttempts: 3, backoffBaseMs: 10_000, deliver: failDeliver });
      [current] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id));
      expect(current.attempts).toBe(2);
      expect(current.availableAt.getTime()).toBe(t1.getTime() + 20_000);

      // Attempt 3 at t1 + 20s fails -> exhausted -> dead_letter!
      await requeueFailedOutboxEvents(db, { organizationId: f.organizationId, now: new Date(t1.getTime() + 20_000), onlyDue: true });
      const t2 = new Date(t1.getTime() + 20_000);
      const dlqRes = await processOutbox(db, { organizationId: f.organizationId, now: t2, maxAttempts: 3, backoffBaseMs: 10_000, deliver: failDeliver });
      expect(dlqRes.deadLettered).toBe(1);
      [current] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id));
      expect(current.state).toBe("dead_letter");
      expect(current.deliveryStatus).toBe("dead_letter");
      expect(deliveryCalls).toBe(3);

      // Explicit admin rescue from DLQ -> successful delivery records provider receipt
      const rescued = await requeueFailedOutboxEvents(db, { organizationId: f.organizationId, now: t2, includeDeadLetter: true });
      expect(rescued.requeued).toBeGreaterThanOrEqual(1);

      const receipt = `rcpt-${rid()}`;
      const okRes = await processOutbox(db, {
        organizationId: f.organizationId,
        now: t2,
        deliver: async () => ({ receiptId: receipt, deliveredAt: t2 }),
      });
      expect(okRes.processed).toBe(1);
      [current] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.id));
      expect(current.state).toBe("processed");
      expect(current.deliveryStatus).toBe("delivered");
      expect(current.providerReceipt).toBe(receipt);
      expect(current.deliveredAt?.getTime()).toBe(t2.getTime());
    });
  });

  describe("lnd-wzt: Real geocoding readiness & SIMULATION_ONLY routing gate", () => {
    const uncodedStops = [
      {
        stopId: "s1", orderId: "o1", buildingId: "b1", address: "Москва, ул. Тверская, 1",
        lat: null, lng: null, kind: "pickup", windowStart: null, windowEnd: null, weightGrams: 1000,
      },
      {
        stopId: "s2", orderId: "o2", buildingId: "b2", address: "Москва, ул. Арбат, 10",
        lat: null, lng: null, kind: "pickup", windowStart: null, windowEnd: null, weightGrams: 1000,
      },
    ];

    it("falls back to honest MANUAL_ORDER with zero fabricated savedMeters when coordinates are missing", () => {
      const res = solveVrptwRoute(uncodedStops);
      expect(res.mode).toBe("MANUAL_ORDER");
      expect(res.distanceVerified).toBe(false);
      expect(res.savedMeters).toBe(0);
      expect(res.naiveDistanceMeters).toBe(0);
      expect(res.optimizedDistanceMeters).toBe(0);
      expect(res.engine).toBe("manual_order");
    });

    it("labels SIMULATION_ONLY explicitly when opted-in outside production and blocks it in production", () => {
      const sim = solveVrptwRoute(uncodedStops, { simulationOnly: true });
      expect(sim.mode).toBe("SIMULATION_ONLY");
      expect(sim.distanceVerified).toBe(false);
      expect(sim.optimizedDistanceMeters).toBeGreaterThan(0);

      const prevEnv = process.env.NODE_ENV;
      const prevAllow = process.env.ALLOW_ROUTING_SIMULATION;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.ALLOW_ROUTING_SIMULATION;
        expect(() => solveVrptwRoute(uncodedStops, { simulationOnly: true }))
          .toThrow("ROUTING_SIMULATION_FORBIDDEN_IN_PRODUCTION");
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevAllow === undefined) delete process.env.ALLOW_ROUTING_SIMULATION;
        else process.env.ALLOW_ROUTING_SIMULATION = prevAllow;
      }
    });

    it("uses real building coordinates when present and sets mode=GEOCODED, distanceVerified=true", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      await db.update(buildings).set({ lat: 55.761, lng: 37.609 }).where(eq(buildings.id, f.buildingId));
      const [b] = await db.select().from(buildings).where(eq(buildings.id, f.buildingId));
      expect(b.lat).toBeCloseTo(55.761, 4);
      expect(b.lng).toBeCloseTo(37.609, 4);

      const geocoded = solveVrptwRoute([
        {
          stopId: "g1", orderId: "o1", buildingId: f.buildingId, address: b.address,
          lat: b.lat, lng: b.lng, kind: "pickup", windowStart: null, windowEnd: null, weightGrams: 1000,
        },
        {
          stopId: "g2", orderId: "o2", buildingId: "b-other", address: "Москва, Красная пл., 1",
          lat: 55.7539, lng: 37.6208, kind: "pickup", windowStart: null, windowEnd: null, weightGrams: 1000,
        },
      ]);
      expect(geocoded.mode).toBe("GEOCODED");
      expect(geocoded.distanceVerified).toBe(true);
      expect(geocoded.optimizedDistanceMeters).toBeGreaterThan(0);
    });
  });

  describe("Bonus finance & privacy completeness endpoints", () => {
    it("supports partner credit note approval, dual-control partner payouts, compensation settlement, and privacy export", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const fin1Phone = `+7999${Math.floor(1e7 + Math.random() * 8e7)}`;
      const fin2Phone = `+7999${Math.floor(1e7 + Math.random() * 8e7)}`;
      const fin1 = await login(f.organizationId, fin1Phone, ["platform_finance"]);
      const fin2 = await login(f.organizationId, fin2Phone, ["platform_finance"]);
      const custSession = await login(f.organizationId, f.phone, ["customer"]);

      // 1. Partner credit note approval
      const [partner] = await db.insert(partners).values({
        organizationId: f.organizationId, name: `Partner ${rid().slice(0, 6)}`,
      }).returning();
      const [pInv] = await db.insert(partnerInvoices).values({
        organizationId: f.organizationId,
        partnerId: partner.id,
        number: `PINV-${rid().slice(0, 8)}`,
        periodStart: new Date(Date.now() - 86_400_000),
        periodEnd: new Date(),
        totalKopeks: 50_000,
      }).returning();
      const [orderLine] = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId)).limit(1);
      const [pContract] = await db.insert(partnerContracts).values({
        partnerId: partner.id,
        version: "1.0",
        effectiveFrom: new Date(Date.now() - 86_400_000),
        signed: true,
      }).returning();
      await db.insert(partnerServiceAccruals).values({
        organizationId: f.organizationId,
        partnerId: partner.id,
        orderLineId: orderLine.id,
        contractId: pContract.id,
        quantity: 1_000,
        amountKopeks: 50_000,
        status: "invoiced",
        disputed: false,
      });
      const [cn] = await db.insert(partnerCreditNotes).values({
        organizationId: f.organizationId,
        invoiceId: pInv.id,
        amountKopeks: 10_000,
        reason: "Перерасчёт за брак",
      }).returning();

      // Customer forbidden
      const custCnRes = await app.inject({
        method: "POST",
        url: `/api/v1/finance/partner-credit-notes/${cn.id}/approve`,
        headers: { cookie: custSession.cookie, "idempotency-key": `cn-c-${rid()}` },
        payload: {},
      });
      expect(custCnRes.statusCode).toBe(403);

      // Finance approves
      const finCnRes = await app.inject({
        method: "POST",
        url: `/api/v1/finance/partner-credit-notes/${cn.id}/approve`,
        headers: { cookie: fin1.cookie, "idempotency-key": `cn-f-${rid()}` },
        payload: {},
      });
      expect(finCnRes.statusCode).toBe(200);
      expect(finCnRes.json().state).toBe("approved");

      // 2. Partner payout dual-control (approver != creator)
      const createPayoutRes = await app.inject({
        method: "POST",
        url: "/api/v1/finance/partner-payouts",
        headers: { cookie: fin1.cookie, "idempotency-key": `po-c-${rid()}` },
        payload: { partnerId: partner.id, amountKopeks: 40_000, reference: "PAY-001" },
      });
      expect(createPayoutRes.statusCode).toBe(200);
      const payoutId = createPayoutRes.json().payoutId as string;

      // Same creator cannot self-approve
      const selfApprove = await app.inject({
        method: "POST",
        url: `/api/v1/finance/partner-payouts/${payoutId}/approve`,
        headers: { cookie: fin1.cookie, "idempotency-key": `po-self-${rid()}` },
        payload: {},
      });
      expect(selfApprove.statusCode).toBe(403);
      expect(selfApprove.json().error.message).toBe("DUAL_CONTROL_REQUIRED");

      // Second finance user approves
      const secondApprove = await app.inject({
        method: "POST",
        url: `/api/v1/finance/partner-payouts/${payoutId}/approve`,
        headers: { cookie: fin2.cookie, "idempotency-key": `po-ok-${rid()}` },
        payload: {},
      });
      expect(secondApprove.statusCode).toBe(200);
      expect(secondApprove.json().state).toBe("approved");
      const [storedPayout] = await db.select().from(partnerPayouts).where(eq(partnerPayouts.id, payoutId));
      expect(storedPayout.createdBy).toBe(fin1.userId);
      expect(storedPayout.approvedBy).toBe(fin2.userId);

      // 3. Claim compensation settle
      const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
      const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
      const finPrincipal = makePrincipal(f.organizationId, fin1.userId, ["platform_finance"]);
      const claim = await openClaim(db, f.principal, {
        orderId: f.orderId, claimType: "damage", description: "Компенсация за повреждение", key: `cl-${rid()}`,
      });
      await decideClaim(db, approver, {
        claimId: claim.claimId, outcome: "resolved", rationale: "Одобрена компенсация клиенту", key: `dc-${rid()}`,
      });
      const comp = await proposeCompensation(db, support, {
        claimId: claim.claimId, amountKopeks: 25_000, key: `pc-${rid()}`,
      });
      await decideCompensation(db, finPrincipal, {
        compensationId: comp.compensationId, approve: true, key: `ac-${rid()}`,
      });
      const settleRes = await app.inject({
        method: "POST",
        url: `/api/v1/claims/${claim.claimId}/compensation/settle`,
        headers: { cookie: fin1.cookie, "idempotency-key": `sc-${rid()}` },
        payload: {},
      });
      expect(settleRes.statusCode).toBe(200);
      expect(settleRes.json().state).toBe("paid");
      const [settledComp] = await db.select().from(compensations).where(eq(compensations.id, comp.compensationId));
      expect(settledComp.state).toBe("paid");

      // 4. Privacy export (zero internal fields)
      const privRes = await app.inject({
        method: "GET",
        url: "/api/v1/me/privacy-export",
        headers: { cookie: custSession.cookie },
      });
      expect(privRes.statusCode).toBe(200);
      const privJson = privRes.json();
      expect(privJson.profile.id).toBe(f.userId);
      expect(privJson.orders.map((o: { id: string }) => o.id)).toContain(f.orderId);
      expect(privJson.claims.map((c: { id: string }) => c.id)).toContain(claim.claimId);
      expect(privRes.body).not.toContain("doorCodeEncrypted");
      expect(privRes.body).not.toContain("handoffCodeHash");
      expect(privRes.body).not.toContain("dedupeKey");
      expect(privRes.body).not.toContain("objectKey");
    });
  });
});
