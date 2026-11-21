import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  containerAssignments, containers, custodyDiscrepancies, customerInvoices, ledgerAccounts,
  ledgerEntries, ledgerJournals, orders, outboxEvents, partnerCreditNotes, partnerServiceAccruals,
  qualityChecks, seals,
} from "../../src/db/schema.js";
import { makePrincipal, seedAddress, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartner, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { login, seedOrder, uniquePhone } from "./_fixtures.js";
import { recordIntake } from "../../src/services/intake.js";
import {
  completeProcessing, receiveHandoff, recordQualityCheck, returnUnprocessedOrder,
  startInspection, startProcessing,
} from "../../src/services/partner.js";
import {
  approvePartnerCreditNote, capturePayment, createCustomerInvoice, createPartnerInvoice,
  refundPayment,
} from "../../src/services/finance.js";
import { cancelOrder } from "../../src/services/orders.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3B partner, finance & orders remediation", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function receiveEconomyOrder(intakeWeightGrams = 1_000) {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-W3B-${rid().slice(0, 6)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: intakeWeightGrams }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: intakeWeightGrams }],
      key: `receipt-${rid()}`,
    });
    return { f, partner, seal, bag, intake };
  }

  it("a) Partner A cannot break Partner B's seal using Partner A's orderId (returns 404, Partner B's seal stays intact)", async () => {
    const orderA = await seedFullOrder(db, { state: "pickup_assigned" });
    const sealA = await seedSeal(db, orderA.organizationId, `SEAL-A-${rid().slice(0, 6)}`);
    const partnerA = await seedPartnerForOrder(db, orderA);
    await recordIntake(db, orderA.courier, {
      orderId: orderA.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: `BAG-A-${rid().slice(0, 6)}`, sealSerial: sealA.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-a-${rid()}`,
    });

    // Order B in the SAME organization assigned to Partner B with sealB
    const partnerB = await seedPartner(db, orderA.organizationId);
    const addressB = await seedAddress(db, orderA.organizationId, orderA.userId, orderA.buildingId);
    const { order: orderBInSameOrg } = await seedOrder(db, {
      organizationId: orderA.organizationId,
      customerId: orderA.userId,
      addressId: addressB,
      tariffVersionId: orderA.catalog.tariffVersionId,
      termsVersion: orderA.catalog.termsVersion,
      publicNumber: `ORD-B-${rid().slice(0, 6)}`,
      lifecycleState: "pickup_assigned",
      assignedPartnerId: partnerB.partnerId,
    });
    const sealB = await seedSeal(db, orderA.organizationId, `SEAL-B-${rid().slice(0, 6)}`);
    const bagB = `BAG-B-${rid().slice(0, 6)}`;
    const [containerB] = await db.insert(containers).values({
      organizationId: orderA.organizationId,
      code: bagB,
    }).returning();
    await db.update(seals).set({ state: "assigned" }).where(eq(seals.id, sealB.id));
    await db.insert(containerAssignments).values({
      organizationId: orderA.organizationId,
      containerId: containerB.id,
      orderId: orderBInSameOrg.id,
      sealId: sealB.id,
    });

    const partnerASession = await login(app, {
      organizationId: orderA.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: partnerA.partnerId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/custody/seals/broken",
      headers: {
        cookie: partnerASession.cookie,
        "idempotency-key": `brk-${rid()}`,
      },
      payload: {
        orderId: orderA.orderId,
        sealSerial: sealB.serial,
        reason: "Попытка испортить чужую пломбу",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");

    const [sealBAfter] = await db.select().from(seals).where(eq(seals.id, sealB.id)).limit(1);
    expect(sealBAfter.state).toBe("assigned");

    const incidentsA = await db.select().from(custodyDiscrepancies)
      .where(eq(custodyDiscrepancies.orderId, orderA.orderId));
    expect(incidentsA).toHaveLength(0);

    const eventsA = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateId, orderA.orderId),
      eq(outboxEvents.eventType, "custody.seal_broken"),
    ));
    expect(eventsA).toHaveLength(0);
  });

  it("b) Invoice +600 -> return-unprocessed -> approve credit note -600 -> next partner invoice does NOT double-reverse (partner_payable nets to 0)", async () => {
    const { f, partner } = await receiveEconomyOrder(1_000);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    // 1. Invoice +600 -> partner_payable credit 600
    const inv1 = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv1-${rid()}`,
    });
    expect(inv1.totalKopeks).toBe(600);

    // 2. Return unprocessed -> creates draft credit note for 600, offsetting accrual marked "credited"
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
    await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Возврат после выставления счёта партнёра",
      key: `ret-${rid()}`,
    });

    const creditNotes = await db.select().from(partnerCreditNotes)
      .where(eq(partnerCreditNotes.invoiceId, inv1.invoiceId));
    expect(creditNotes).toHaveLength(1);
    expect(creditNotes[0].amountKopeks).toBe(600);
    expect(creditNotes[0].state).toBe("draft");

    const accruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    expect(accruals).toHaveLength(2);
    expect(accruals.some(a => a.status === "credited" && a.amountKopeks === -600)).toBe(true);

    // 3. Approve credit note -> posts partner_payable debit 600
    await approvePartnerCreditNote(db, finance, {
      creditNoteId: creditNotes[0].id,
      key: `cn-app-${rid()}`,
    });

    // 4. Next partner invoice must NOT claim the -600 offsetting accrual
    const inv2 = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv2-${rid()}`,
    });
    expect(inv2.totalKopeks).toBe(0);
    expect(inv2.lineCount).toBe(0);

    // 5. Verify ledger partner_payable nets to 0 (600 credit - 600 debit = 0)
    const [payableAccount] = await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.organizationId, f.organizationId),
      eq(ledgerAccounts.code, "partner_payable"),
    )).limit(1);
    expect(payableAccount).toBeDefined();

    const journals = await db.select().from(ledgerJournals)
      .where(eq(ledgerJournals.organizationId, f.organizationId));
    const journalIds = journals.map(j => j.id);
    const payableEntries = await db.select().from(ledgerEntries).where(and(
      inArray(ledgerEntries.journalId, journalIds),
      eq(ledgerEntries.accountId, payableAccount.id),
    ));
    const netPayable = payableEntries.reduce((sum, e) => sum + e.creditKopeks - e.debitKopeks, 0);
    expect(netPayable).toBe(0);
  });

  it("c) Cancelled order cancels open invoice and blocks both createCustomerInvoice and capturePayment with ORDER_CANCELLED", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const inv = await createCustomerInvoice(db, finance, {
      orderId: f.orderId,
      key: `inv-cancel-${rid()}`,
    });
    expect(inv.totalKopeks).toBeGreaterThan(0);

    const cancelled = await cancelOrder(db, f.principal, {
      orderId: f.orderId,
      reason: "Клиент отменил заказ",
      key: `cancel-${rid()}`,
    });
    expect(cancelled.state).toBe("cancelled");

    const [invRow] = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.id, inv.invoiceId)).limit(1);
    expect(invRow.state).toBe("cancelled");

    await expect(createCustomerInvoice(db, finance, {
      orderId: f.orderId,
      key: `inv-after-cancel-${rid()}`,
    })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: "ORDER_CANCELLED",
    });

    await expect(capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: inv.totalKopeks,
      key: `cap-after-cancel-${rid()}`,
    })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: "ORDER_CANCELLED",
    });
  });

  it("d) Fully-refunded order can be returned unprocessed without ORDER_ALREADY_CHARGED", async () => {
    const { f, partner } = await receiveEconomyOrder(1_000);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const inv = await createCustomerInvoice(db, finance, {
      orderId: f.orderId,
      key: `inv-ref-${rid()}`,
    });
    const cap = await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: inv.totalKopeks,
      key: `cap-ref-${rid()}`,
    });
    await refundPayment(db, finance, {
      paymentIntentId: cap.paymentIntentId,
      amountKopeks: inv.totalKopeks,
      reason: "Полный возврат перед возвратом вещей без обработки",
      key: `refund-full-${rid()}`,
    });

    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-ref-${rid()}` });
    const ret = await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Возврат после полного возврата оплаты",
      key: `ret-ref-${rid()}`,
    });
    expect(ret.state).toBe("ready");

    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, f.orderId)).limit(1);
    expect(orderAfter.lifecycleState).toBe("ready");
  });

  it("e) Economy QC inserts an explicit order-level qualityChecks row (garmentId = null)", async () => {
    const { f, partner } = await receiveEconomyOrder(1_000);
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-qc-${rid()}` });
    await startProcessing(db, partner.principal, {
      orderId: f.orderId,
      processType: "wash_40c",
      key: `proc-qc-${rid()}`,
    });
    await completeProcessing(db, partner.principal, {
      orderId: f.orderId,
      key: `comp-qc-${rid()}`,
    });

    const qc = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [],
      bagPassed: true,
      key: `qc-eco-${rid()}`,
    });
    expect(qc.state).toBe("ready");
    expect(qc.allPassed).toBe(true);

    const rows = await db.select().from(qualityChecks).where(eq(qualityChecks.orderId, f.orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0].garmentId).toBeNull();
    expect(rows[0].result).toBe("passed");
    expect(rows[0].actorId).toBe(partner.userId);
  });
});
