import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { custodyEvents, ledgerAccounts, ledgerEntries, ledgerJournals, orders, tariffVersions } from "../src/db/schema.js";
import { and, inArray } from "drizzle-orm";

import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedPartner, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { recordIntake, syncScanEvents } from "../src/services/intake.js";
import { receiveHandoff, reportSealBroken, startInspection, startProcessing, recordQualityCheck } from "../src/services/partner.js";
import { arriveStop, assignDelivery, closeOrder, recordDeliveryAttempt } from "../src/services/delivery.js";
import { ensureLedgerAccounts, postJournal } from "../src/services/finance.js";
import { createQuote } from "../src/services/quotes.js";
import { canonicalScanHash } from "../src/core/scan-hash.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Verification-loop gaps", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function intakeFixture() {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const bag = `GAP-${Math.random().toString(36).slice(2)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: `intake-${f.orderId}`,
    });
    return { ...f, seal, bag, intake };
  }

  it("C02: a broken seal blocks partner receipt and opens an incident", async () => {
    const f = await intakeFixture();
    const partner = await seedPartnerForOrder(db, f);
    const report = await reportSealBroken(db, partner.principal, {
      orderId: f.orderId, sealSerial: f.seal.serial, reason: "пломба повреждена", key: "broken-seal-1",
    });
    expect(report.state).toBe("broken");
    await expect(receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: f.intake.manifestId,
      actual: [{ containerCode: f.bag, sealSerial: f.seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-after-broken",
    })).rejects.toThrow("SEAL_NOT_INTACT");
  });

  it("E05: a second partner cannot take over an order already assigned to another partner", async () => {
    const f = await intakeFixture();
    const first = await seedPartnerForOrder(db, f);
    await receiveHandoff(db, first.principal, {
      orderId: f.orderId, manifestId: f.intake.manifestId,
      actual: [{ containerCode: f.bag, sealSerial: f.seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-first-partner",
    });
    const second = await seedPartner(db, f.organizationId);
    await expect(receiveHandoff(db, second.principal, {
      orderId: f.orderId, manifestId: f.intake.manifestId,
      actual: [{ containerCode: f.bag, sealSerial: f.seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-second-partner",
    })).rejects.toThrow("NOT_FOUND");
  });

  it("custody events are immutable at the database level", async () => {
    const f = await intakeFixture();
    const [event] = await db.select().from(custodyEvents).where(eq(custodyEvents.orderId, f.orderId));
    expect(event).toBeDefined();
    const custodyError = await db.update(custodyEvents).set({ toParty: "partner" })
      .where(eq(custodyEvents.id, event.id)).then(() => null, error => error);
    expect(String(custodyError?.cause ?? custodyError)).toContain("APPEND_ONLY");
  });

  it("ledger journals reject unbalanced postings and entries are append-only", async () => {
    const f = await intakeFixture();
    await expect(db.transaction(tx => postJournal(tx, {
      organizationId: f.organizationId,
      sourceType: "test", sourceId: randomUUID(), description: "bad",
      lines: [{ accountCode: "clearing", debitKopeks: 100 }],
    }))).rejects.toThrow("UNBALANCED_JOURNAL");

    await ensureLedgerAccounts(db, f.organizationId);
    const [journal] = await db.insert(ledgerJournals).values({
      organizationId: f.organizationId, sourceType: "test", sourceId: randomUUID(), description: "balanced",
    }).returning();
    const accounts = await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.organizationId, f.organizationId),
      inArray(ledgerAccounts.code, ["clearing", "advances"]),
    ));
    if (accounts.length === 2) {
      const clearing = accounts.find(row => row.code === "clearing")!;
      const advances = accounts.find(row => row.code === "advances")!;
      await db.insert(ledgerEntries).values([
        { journalId: journal.id, accountId: clearing.id, debitKopeks: 100 },
        { journalId: journal.id, accountId: advances.id, creditKopeks: 100 },
      ]);
      const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.journalId, journal.id));
      const ledgerError = await db.update(ledgerEntries).set({ debitKopeks: 200 })
        .where(eq(ledgerEntries.id, entry.id)).then(() => null, error => error);
      expect(String(ledgerError?.cause ?? ledgerError)).toContain("APPEND_ONLY");
    }
  });

  it("B05: concurrent offline replays of one client event are accepted exactly once", async () => {
    const f = await intakeFixture();
    const eventBase = {
      clientEventId: randomUUID(), deviceId: f.deviceId, scannedType: "order" as const,
      scannedId: f.orderId, capturedAt: "2026-12-01T10:00:00.000Z", context: {},
    };
    const event = { ...eventBase, payloadHash: canonicalScanHash(eventBase) };
    const results = await Promise.all([
      syncScanEvents(db, f.courier, [event]),
      syncScanEvents(db, f.courier, [event]),
    ]);
    expect(results.flatMap(result => result.accepted)).toHaveLength(1);
    expect(results.flatMap(result => result.duplicate)).toHaveLength(1);
  });

  it("A02: a tariff version past its effective window cannot produce a new quote", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(tariffVersions).set({ effectiveTo: new Date("2026-02-01T00:00:00Z") })
      .where(eq(tariffVersions.id, f.catalog.tariffVersionId));
    await expect(createQuote(db, f.principal, {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: "quote-expired-tariff",
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    })).rejects.toThrow("NOT_FOUND");
  });

  it("V2-01: partial delivery without an exception record cannot be closed away", async () => {
    const f = await intakeFixture();
    const partner = await seedPartnerForOrder(db, f);
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: f.intake.manifestId,
      actual: [{ containerCode: f.bag, sealSerial: f.seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-close",
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: "inspect-close" });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: "batch-close" });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], key: "qc-close" });
    const assigned = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: "assign-close" });
    await arriveStop(db, f.courier, { stopId: assigned.stopId, key: "arrive-close" });
    await recordDeliveryAttempt(db, f.courier, {
      stopId: assigned.stopId, outcome: "partial", deliveredGarmentIds: [],
      recipientProof: { method: "code", value: "9999" }, key: "attempt-close",
    });
    await db.update(orders).set({ lifecycleState: "delivered" }).where(eq(orders.id, f.orderId));
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    await expect(closeOrder(db, finance, { orderId: f.orderId, key: "close-guard" }))
      .rejects.toThrow("PARTIAL_DELIVERY_REQUIRES_EXCEPTION");
  });

  it("D02: delivery with proof missing is rejected before any attempt is recorded", async () => {
    const f = await intakeFixture();
    const partner = await seedPartnerForOrder(db, f);
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: f.intake.manifestId,
      actual: [{ containerCode: f.bag, sealSerial: f.seal.serial, actualWeightGrams: 1_000 }],
      key: "receipt-proof",
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: "inspect-proof" });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: "batch-proof" });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], key: "qc-proof" });
    const assigned = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: "assign-proof" });
    await arriveStop(db, f.courier, { stopId: assigned.stopId, key: "arrive-proof" });
    await expect(recordDeliveryAttempt(db, f.courier, {
      stopId: assigned.stopId, outcome: "delivered", key: "attempt-no-proof",
    })).rejects.toThrow("RECIPIENT_PROOF_REQUIRED");
  });
});
