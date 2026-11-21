import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  claims, ledgerAccounts, ledgerEntries, ledgerJournals, notifications, outboxEvents,
  partnerCreditNotes, partnerDisputes, partnerInvoiceLines, partnerServiceAccruals,
  paymentEvents, paymentIntents,
} from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { login, seedOrder, seedTenant, uniquePhone } from "./_fixtures.js";
import { recordIntake } from "../../src/services/intake.js";
import { receiveHandoff } from "../../src/services/partner.js";
import {
  approvePartnerCreditNote, capturePayment, createCustomerInvoice, createPartnerInvoice,
  createPartnerPayout, disputePartnerLine, listChargebacks, refundPayment, resolvePartnerDispute,
} from "../../src/services/finance.js";
import { processOutbox } from "../../src/services/outbox.js";
import { processPaymentInbox, requeueFailedPaymentEvents } from "../../src/services/payment-inbox.js";
// @ts-expect-error ESM script helper exports parseCsv and readPreviousE2eRows
import { parseCsv, readPreviousE2eRows } from "../../scripts/generate-scenario-status.mjs";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 5 Track B: finance disputes, outbox/inbox leases, overview chargebacks & CSV parser", () => {
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

  async function seedBilledPartnerLine(weightGrams = 2_000) {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-W5-${rid().slice(0, 6)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: weightGrams }],
      key: `receipt-${rid()}`,
    });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const financeLogin = await login(app, {
      organizationId: f.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });
    const inv = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv-${rid()}`,
    });
    const [line] = await db.select().from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.invoiceId, inv.invoiceId)).limit(1);
    const partnerFinancePrincipal = makePrincipal(f.organizationId, partner.userId, ["partner_finance"], {
      partnerId: partner.partnerId,
    });
    const opened = await disputePartnerLine(db, partnerFinancePrincipal, {
      lineId: line.id,
      reason: "Спорное начисление по тарифу",
      key: `disp-${rid()}`,
    });
    return { f, partner, finance, financeLogin, inv, line, disputeId: opened.disputeId };
  }

  it("LND-PRO-005: resolves partner disputes with upheld, rejected, and partial outcomes and updates payable + ledger", async () => {
    // 1. UPHELD -> full credit note, line credited, remaining payable = 0
    const u = await seedBilledPartnerLine(2_000);
    const upheldRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${u.disputeId}/resolve`,
      headers: { cookie: u.financeLogin.cookie, "idempotency-key": `res-up-${rid()}` },
      payload: { outcome: "upheld", reason: "Претензия партнёра обоснована полностью" },
    });
    expect(upheldRes.statusCode, upheldRes.body).toBe(200);
    const upheldBody = upheldRes.json() as {
      state: string; lineState: string; creditKopeks: number; creditNoteId: string;
    };
    expect(upheldBody).toMatchObject({
      state: "resolved",
      lineState: "credited",
      creditKopeks: u.line.amountKopeks,
    });

    const [uDispute] = await db.select().from(partnerDisputes).where(eq(partnerDisputes.id, u.disputeId));
    expect(uDispute.state).toBe("resolved");
    const [uLine] = await db.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.id, u.line.id));
    expect(uLine.state).toBe("credited");
    const [uOrigAccrual] = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.id, u.line.accrualId));
    expect(uOrigAccrual.disputed).toBe(false);
    const uAccruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, u.partner.partnerId));
    expect(uAccruals.some(a => a.status === "credited" && a.amountKopeks === -u.line.amountKopeks)).toBe(true);

    const [uCn] = await db.select().from(partnerCreditNotes).where(eq(partnerCreditNotes.id, upheldBody.creditNoteId));
    expect(uCn.state).toBe("draft");
    expect(uCn.originalLineId).toBe(u.line.id);
    expect(uCn.amountKopeks).toBe(u.line.amountKopeks);

    await approvePartnerCreditNote(db, u.finance, { creditNoteId: uCn.id, key: `ap-up-${rid()}` });

    // Next partner invoice must NOT double-claim the credited accrual
    const nextInv = await createPartnerInvoice(db, u.finance, {
      partnerId: u.partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv-next-${rid()}`,
    });
    expect(nextInv.totalKopeks).toBe(0);

    // Remaining payable is 0 -> even 1 kopek payout is refused
    await expect(createPartnerPayout(db, u.finance, {
      partnerId: u.partner.partnerId,
      amountKopeks: 1,
      key: `pay-u-${rid()}`,
    })).rejects.toMatchObject({ message: "PAYOUT_EXCEEDS_PAYABLE" });

    // Re-resolving closed dispute fails with 409
    const dupRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${u.disputeId}/resolve`,
      headers: { cookie: u.financeLogin.cookie, "idempotency-key": `res-dup-${rid()}` },
      payload: { outcome: "rejected", reason: "Повторное закрытие" },
    });
    expect(dupRes.statusCode).toBe(409);

    // 2. REJECTED -> no credit note, line accepted, full payable remains
    const r = await seedBilledPartnerLine(2_000);
    const rejectedRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${r.disputeId}/resolve`,
      headers: { cookie: r.financeLogin.cookie, "idempotency-key": `res-rej-${rid()}` },
      payload: { outcome: "rejected", reason: "Тариф применён корректно" },
    });
    expect(rejectedRes.statusCode, rejectedRes.body).toBe(200);
    expect(rejectedRes.json()).toMatchObject({
      state: "rejected",
      lineState: "accepted",
      creditKopeks: 0,
      creditNoteId: null,
    });
    const rCns = await db.select().from(partnerCreditNotes)
      .where(eq(partnerCreditNotes.invoiceId, r.inv.invoiceId));
    expect(rCns).toHaveLength(0);
    const rPayout = await createPartnerPayout(db, r.finance, {
      partnerId: r.partner.partnerId,
      amountKopeks: r.line.amountKopeks,
      key: `pay-r-${rid()}`,
    });
    expect(rPayout.amountKopeks).toBe(r.line.amountKopeks);

    // 3. PARTIAL -> validates bounds, creates partial credit note, leaves remaining payable
    const p = await seedBilledPartnerLine(2_000); // 1200 kopeks
    const badPartial = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${p.disputeId}/resolve`,
      headers: { cookie: p.financeLogin.cookie, "idempotency-key": `res-bad-${rid()}` },
      payload: { outcome: "partial", creditKopeks: p.line.amountKopeks, reason: "Некорректная сумма" },
    });
    expect(badPartial.statusCode).toBe(400);

    const partialCredit = Math.floor(p.line.amountKopeks / 3);
    const partialRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${p.disputeId}/resolve`,
      headers: { cookie: p.financeLogin.cookie, "idempotency-key": `res-part-${rid()}` },
      payload: { outcome: "partial", creditKopeks: partialCredit, reason: "Частичная скидка по акту" },
    });
    expect(partialRes.statusCode, partialRes.body).toBe(200);
    const partialBody = partialRes.json() as {
      state: string; lineState: string; creditKopeks: number; creditNoteId: string;
    };
    expect(partialBody).toMatchObject({
      state: "resolved",
      lineState: "accepted",
      creditKopeks: partialCredit,
    });
    await approvePartnerCreditNote(db, p.finance, {
      creditNoteId: partialBody.creditNoteId,
      key: `ap-part-${rid()}`,
    });

    const expectedRemaining = p.line.amountKopeks - partialCredit;
    await expect(createPartnerPayout(db, p.finance, {
      partnerId: p.partner.partnerId,
      amountKopeks: expectedRemaining + 1,
      key: `pay-p-over-${rid()}`,
    })).rejects.toMatchObject({ message: "PAYOUT_EXCEEDS_PAYABLE" });

    const okRemainingPayout = await createPartnerPayout(db, p.finance, {
      partnerId: p.partner.partnerId,
      amountKopeks: expectedRemaining,
      key: `pay-p-ok-${rid()}`,
    });
    expect(okRemainingPayout.amountKopeks).toBe(expectedRemaining);

    // Ledger partner_payable net equals expectedRemaining before payout approval
    const [payableAccount] = await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.organizationId, p.f.organizationId),
      eq(ledgerAccounts.code, "partner_payable"),
    )).limit(1);
    const journals = await db.select().from(ledgerJournals)
      .where(eq(ledgerJournals.organizationId, p.f.organizationId));
    const entries = await db.select().from(ledgerEntries).where(and(
      inArray(ledgerEntries.journalId, journals.map(j => j.id)),
      eq(ledgerEntries.accountId, payableAccount.id),
    ));
    const netPayable = entries.reduce((sum, e) => sum + e.creditKopeks - e.debitKopeks, 0);
    expect(netPayable).toBe(expectedRemaining);
  });

  it("CLS-002 (PRO-005): enforces cumulative credit cap, rejects duplicate open disputes, resolves investigating disputes, and reconciles ledger/payable to 0", async () => {
    const c = await seedBilledPartnerLine(2_000); // 1200 kopeks
    const partnerFinance = makePrincipal(c.f.organizationId, c.partner.userId, ["partner_finance"], {
      partnerId: c.partner.partnerId,
    });

    // 1. Opening a second dispute while one is open fails with 409 DISPUTE_ALREADY_OPEN
    await expect(disputePartnerLine(db, partnerFinance, {
      lineId: c.line.id,
      reason: "Дублирующая претензия на ту же строку",
      key: `disp-dup-${rid()}`,
    })).rejects.toMatchObject({ status: 409, message: "DISPUTE_ALREADY_OPEN" });

    // Partial unique index also blocks duplicate open/investigating disputes at DB level
    await expect(db.insert(partnerDisputes).values({
      organizationId: c.f.organizationId,
      invoiceLineId: c.line.id,
      openedBy: c.partner.userId,
      reason: "Прямой обход в БД",
      state: "investigating",
    })).rejects.toThrow();

    // 2. Partial resolution on dispute #1
    const firstCredit = Math.floor(c.line.amountKopeks / 3); // 400
    const res1 = await resolvePartnerDispute(db, c.finance, {
      disputeId: c.disputeId,
      outcome: "partial",
      creditKopeks: firstCredit,
      reason: "Первая частичная скидка",
      key: `cls2-part1-${rid()}`,
    });
    expect(res1).toMatchObject({
      state: "resolved",
      lineState: "accepted",
      creditKopeks: firstCredit,
    });

    // 3. Re-open dispute #2 on the same line and move it to 'investigating'
    const opened2 = await disputePartnerLine(db, partnerFinance, {
      lineId: c.line.id,
      reason: "Повторная претензия на остаток",
      key: `disp-2-${rid()}`,
    });
    await db.update(partnerDisputes)
      .set({ state: "investigating" })
      .where(eq(partnerDisputes.id, opened2.disputeId));

    const remaining = c.line.amountKopeks - firstCredit; // 800
    // Over-credit or equal-to-remaining partial resolution must be rejected with 400 CREDIT_AMOUNT_INVALID
    for (const invalidKopeks of [remaining, remaining + 100]) {
      const badRes = await app.inject({
        method: "POST",
        url: `/api/v1/finance/partner-disputes/${opened2.disputeId}/resolve`,
        headers: { cookie: c.financeLogin.cookie, "idempotency-key": `cls2-bad-${invalidKopeks}-${rid()}` },
        payload: { outcome: "partial", creditKopeks: invalidKopeks, reason: "Попытка перекредитовать" },
      });
      expect(badRes.statusCode).toBe(400);
      expect(badRes.json().error.message).toBe("CREDIT_AMOUNT_INVALID");
    }

    // 4. Upheld resolution on 'investigating' dispute #2 caps credit at remainingCreditableKopeks
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-disputes/${opened2.disputeId}/resolve`,
      headers: { cookie: c.financeLogin.cookie, "idempotency-key": `cls2-up2-${rid()}` },
      payload: { outcome: "upheld", reason: "Удовлетворение на оставшуюся сумму" },
    });
    expect(res2.statusCode, res2.body).toBe(200);
    const res2Body = res2.json() as {
      state: string; lineState: string; creditKopeks: number; creditNoteId: string;
    };
    expect(res2Body).toMatchObject({
      state: "resolved",
      lineState: "credited",
      creditKopeks: remaining,
    });

    const cns = await db.select().from(partnerCreditNotes)
      .where(eq(partnerCreditNotes.originalLineId, c.line.id));
    expect(cns).toHaveLength(2);
    expect(cns.reduce((acc, cn) => acc + cn.amountKopeks, 0)).toBe(c.line.amountKopeks);
    expect(cns.find(cn => cn.id === res2Body.creditNoteId)?.disputeId).toBe(opened2.disputeId);

    // 5. Re-disputing a fully credited line is rejected with 409 LINE_ALREADY_CREDITED
    await expect(disputePartnerLine(db, partnerFinance, {
      lineId: c.line.id,
      reason: "Спор после полного кредитования",
      key: `disp-3-${rid()}`,
    })).rejects.toMatchObject({ status: 409, message: "LINE_ALREADY_CREDITED" });

    // 6. Approve all credit notes and reconcile payable + ledger partner_payable to 0
    for (const cn of cns) {
      await approvePartnerCreditNote(db, c.finance, { creditNoteId: cn.id, key: `ap-cls2-${cn.id}-${rid()}` });
    }
    await expect(createPartnerPayout(db, c.finance, {
      partnerId: c.partner.partnerId,
      amountKopeks: 1,
      key: `pay-cls2-zero-${rid()}`,
    })).rejects.toMatchObject({ message: "PAYOUT_EXCEEDS_PAYABLE" });

    const [payableAccount] = await db.select().from(ledgerAccounts).where(and(
      eq(ledgerAccounts.organizationId, c.f.organizationId),
      eq(ledgerAccounts.code, "partner_payable"),
    )).limit(1);
    const journals = await db.select().from(ledgerJournals)
      .where(eq(ledgerJournals.organizationId, c.f.organizationId));
    const entries = await db.select().from(ledgerEntries).where(and(
      inArray(ledgerEntries.journalId, journals.map(j => j.id)),
      eq(ledgerEntries.accountId, payableAccount.id),
    ));
    const netPayable = entries.reduce((acc, e) => acc + e.creditKopeks - e.debitKopeks, 0);
    expect(netPayable).toBe(0);
  });

  it("CLS-006 (PRO-008): listChargebacks paginates >50 chargebacks with tied timestamps, search, state filter, tenant isolation, and invalid cursor 400", async () => {
    const tenant = await seedTenant(db);
    const otherTenant = await seedTenant(db);

    const { order: orderA } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `CBA-${rid().slice(0, 6)}`,
    });
    const { order: orderB } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `CBB-${rid().slice(0, 6)}`,
    });
    const { order: otherOrder } = await seedOrder(db, {
      organizationId: otherTenant.organizationId,
      customerId: otherTenant.userId,
      addressId: otherTenant.addressId,
      tariffVersionId: otherTenant.catalog.tariffVersionId,
      termsVersion: otherTenant.catalog.termsVersion,
      publicNumber: `CB-OTHER-${rid().slice(0, 6)}`,
    });

    const baseTime = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const tiedTime = new Date(baseTime + 32 * 60_000); // sits around index 32 -> crosses page boundary with limit=20

    // Seed 52 chargebacks (mix of disputed & chargeback_lost, including tied timestamps)
    const chargebackSeedRows = Array.from({ length: 52 }, (_, i) => ({
      organizationId: tenant.organizationId,
      orderId: i === 0 ? orderB.id : orderA.id,
      provider: "fake",
      providerIntentId: i === 0 ? "prov_50%_special" : `prov-cb-${i}-${rid().slice(0, 6)}`,
      amountKopeks: 20_000 + i,
      state: (i % 3 === 0 ? "chargeback_lost" : "disputed") as "disputed" | "chargeback_lost",
      idempotencyKey: `cls6-cb-${i}-${rid()}`,
      // Make indices 31, 32, 33 share the exact same timestamp (crossing limit=20 boundary from page 1->2)
      createdAt: (i >= 31 && i <= 33) ? tiedTime : new Date(baseTime + i * 60_000),
    }));
    const insertedChargebacks = await db.insert(paymentIntents).values(chargebackSeedRows).returning();

    // Seed 56 newer normal captured payments so overview recent-50 intents don't include older chargebacks
    await db.insert(paymentIntents).values(
      Array.from({ length: 56 }, (_, i) => ({
        organizationId: tenant.organizationId,
        orderId: orderA.id,
        provider: "fake",
        amountKopeks: 5_000 + i,
        state: "captured" as const,
        idempotencyKey: `cls6-cap-${i}-${rid()}`,
        createdAt: new Date(baseTime + (100 + i) * 60_000),
      })),
    );

    // Seed another tenant's chargeback that must remain invisible
    const [foreignCb] = await db.insert(paymentIntents).values({
      organizationId: otherTenant.organizationId,
      orderId: otherOrder.id,
      provider: "fake",
      providerIntentId: orderB.publicNumber,
      amountKopeks: 99_000,
      state: "disputed",
      idempotencyKey: `cls6-other-${rid()}`,
      createdAt: new Date(baseTime + 200 * 60_000),
    }).returning();

    const financePrincipal = makePrincipal(tenant.organizationId, await seedUser(db, tenant.organizationId), ["platform_finance"]);

    // 1. Cursor walk across all 52 chargebacks with limit=20 -> 0 duplicates, 0 skips
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listChargebacks(db, financePrincipal, { limit: 20, cursor });
      expect(page.totalCount).toBe(52);
      expect(page.items.every(item => item.organizationId === tenant.organizationId)).toBe(true);
      expect(page.items.every(item => typeof item.orderPublicNumber === "string" && item.orderPublicNumber.length > 0)).toBe(true);
      seenIds.push(...page.items.map(i => i.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor);

    expect(pages).toBe(3);
    expect(seenIds).toHaveLength(52);
    expect(new Set(seenIds).size).toBe(52);
    expect(seenIds).not.toContain(foreignCb.id);
    for (const cb of insertedChargebacks) {
      expect(seenIds).toContain(cb.id);
    }

    // 2. Search `q` finds oldest (#52 in descending order, i.e., index 0) by id, orderPublicNumber, and literal % in providerIntentId
    const oldestCb = insertedChargebacks[0];
    for (const query of [oldestCb.id, orderB.publicNumber, "prov_50%_special"]) {
      const found = await listChargebacks(db, financePrincipal, { q: query });
      expect(found.totalCount).toBe(1);
      expect(found.items.map(i => i.id)).toEqual([oldestCb.id]);
    }
    // Literal % escaping: searching for "50%" must NOT match "prov-cb-50-..." unless "50%" literally appears
    const literalPercent = await listChargebacks(db, financePrincipal, { q: "50%" });
    expect(literalPercent.totalCount).toBe(1);
    expect(literalPercent.items[0].id).toBe(oldestCb.id);

    // 3. State filter
    const lostOnly = await listChargebacks(db, financePrincipal, { limit: 100, state: "chargeback_lost" });
    const disputedOnly = await listChargebacks(db, financePrincipal, { limit: 100, state: "disputed" });
    expect(lostOnly.items.every(i => i.state === "chargeback_lost")).toBe(true);
    expect(disputedOnly.items.every(i => i.state === "disputed")).toBe(true);
    expect(lostOnly.totalCount + disputedOnly.totalCount).toBe(52);

    // 4. Invalid cursor throws 400 VALIDATION_ERROR
    await expect(listChargebacks(db, financePrincipal, { cursor: "not-a-valid-cursor" }))
      .rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR", message: "INVALID_CURSOR" });

    // 5. financeOverview includes backwards-compatible chargebacks/chargebacksMeta AND chargebacksPage
    const financeLogin = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });
    const ovRes = await app.inject({
      method: "GET",
      url: "/api/v1/finance/overview",
      headers: { cookie: financeLogin.cookie },
    });
    expect(ovRes.statusCode, ovRes.body).toBe(200);
    const ovBody = ovRes.json() as {
      chargebacks: Array<{ id: string; orderPublicNumber: string }>;
      chargebacksMeta: { total: number; hasMore: boolean };
      chargebacksPage: { items: Array<{ id: string; orderPublicNumber: string }>; totalCount: number; hasMore: boolean; nextCursor: string | null };
    };
    expect(ovBody.chargebacks).toHaveLength(50);
    expect(ovBody.chargebacksMeta).toEqual({ total: 52, hasMore: true });
    expect(ovBody.chargebacksPage.items).toHaveLength(50);
    expect(ovBody.chargebacksPage.totalCount).toBe(52);
    expect(ovBody.chargebacksPage.hasMore).toBe(true);
    expect(ovBody.chargebacksPage.nextCursor).toBeTruthy();
    expect(ovBody.chargebacks[0].orderPublicNumber).toBeTruthy();
  });

  it("LND-PRO-006: delivers refund and claim notifications (with payload orderId and fallback lookup) without duplicates", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-6-${rid()}` });
    const cap = await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: inv.totalKopeks,
      key: `cap-6-${rid()}`,
    });
    const refundAmount = Math.max(1, Math.floor(inv.totalKopeks / 2));
    const ref = await refundPayment(db, finance, {
      paymentIntentId: cap.paymentIntentId,
      amountKopeks: refundAmount,
      reason: "Частичный возврат",
      key: `ref-6-${rid()}`,
    });

    // Refund event emitted by refundPayment already carries orderId in payloadJson
    const [refundEvt] = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, f.organizationId),
      eq(outboxEvents.aggregateType, "refund"),
      eq(outboxEvents.aggregateId, ref.refundId),
    )).limit(1);
    expect((refundEvt.payloadJson as { orderId?: string }).orderId).toBe(f.orderId);

    // Inject a legacy refund outbox event WITHOUT orderId in payload, and a claim event WITHOUT orderId
    const [legacyRefundEvt] = await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "refund",
      aggregateId: ref.refundId,
      eventType: "payment.refunded",
      payloadJson: { amountKopeks: refundAmount, paymentIntentId: cap.paymentIntentId },
    }).returning();

    const [claim] = await db.insert(claims).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      openedBy: f.userId,
      claimType: "damage",
      state: "opened",
      description: "Тест претензии для outbox fallback",
    }).returning();

    const [claimEvt] = await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "claim",
      aggregateId: claim.id,
      eventType: "claim.decided",
      payloadJson: { outcome: "compensate" },
    }).returning();

    const drainNow = new Date(Date.now() + 5_000);
    const delivered = await processOutbox(db, { organizationId: f.organizationId, limit: 200, now: drainNow });
    expect(delivered.failed).toBe(0);
    expect(delivered.deadLettered).toBe(0);

    for (const evtId of [refundEvt.id, legacyRefundEvt.id, claimEvt.id]) {
      const [evtRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, evtId));
      expect(evtRow.state).toBe("processed");
      expect(evtRow.deliveryStatus).toBe("delivered");
      const notifs = await db.select().from(notifications).where(and(
        eq(notifications.organizationId, f.organizationId),
        eq(notifications.dedupeKey, `outbox:${evtId}`),
      ));
      expect(notifs).toHaveLength(1);
      expect(notifs[0].orderId).toBe(f.orderId);
      expect(notifs[0].recipientId).toBe(f.userId);
    }

    // Re-running processOutbox does not create duplicate notifications
    const secondRun = await processOutbox(db, { organizationId: f.organizationId, limit: 200, now: drainNow });
    expect(secondRun.claimed).toBe(0);
    const refundNotifs = await db.select().from(notifications).where(and(
      eq(notifications.organizationId, f.organizationId),
      eq(notifications.dedupeKey, `outbox:${refundEvt.id}`),
    ));
    expect(refundNotifs).toHaveLength(1);
  });

  it("LND-PRO-007: reaps stale exhausted processing leases in outbox and payment inbox, and requeues exhausted inbox rows on demand", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // Drain any prior org outbox events first
    await processOutbox(db, { organizationId: f.organizationId, limit: 500, now });

    // Outbox stale exhausted lease (attempts === maxAttempts = 5)
    let deliverCalls = 0;
    const [staleOutbox] = await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "order",
      aggregateId: f.orderId,
      eventType: "order.confirmed",
      payloadJson: { orderId: f.orderId },
      state: "processing",
      attempts: 5,
      availableAt: tenMinAgo,
      createdAt: tenMinAgo,
    }).returning();

    const outboxRes = await processOutbox(db, {
      organizationId: f.organizationId,
      now,
      deliver: async req => {
        deliverCalls += 1;
        return { receiptId: `rcpt:${req.dedupeKey}` };
      },
    });
    expect(deliverCalls).toBe(0);
    expect(outboxRes.claimed).toBe(0);
    expect(outboxRes.deadLettered).toBeGreaterThanOrEqual(1);

    const [reapedOutbox] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, staleOutbox.id));
    expect(reapedOutbox.state).toBe("dead_letter");
    expect(reapedOutbox.deliveryStatus).toBe("dead_letter");
    expect(reapedOutbox.error).toBe("STALE_LEASE_EXHAUSTED");

    // Payment inbox stale exhausted lease (attempts === MAX_ATTEMPTS = 5)
    const [intent] = await db.insert(paymentIntents).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      provider: "fake",
      amountKopeks: 10_000,
      state: "pending",
      idempotencyKey: `pi-exh-${rid()}`,
    }).returning();
    const [staleInbox] = await db.insert(paymentEvents).values({
      organizationId: f.organizationId,
      provider: "fake",
      providerEventId: `evt-exh-${rid()}`,
      paymentIntentId: intent.id,
      eventType: "captured",
      payloadHash: "e".repeat(64),
      state: "processing",
      attempts: 5,
      receivedAt: tenMinAgo,
      processedAt: tenMinAgo,
    }).returning();

    const inboxRes = await processPaymentInbox(db, { now });
    expect(inboxRes.failed).toBeGreaterThanOrEqual(1);

    const [reapedInbox] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, staleInbox.id));
    expect(reapedInbox.state).toBe("failed");
    expect(reapedInbox.error).toBe("STALE_LEASE_EXHAUSTED");

    // Standard requeue skips exhausted rows
    await requeueFailedPaymentEvents(db);
    const [stillFailed] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, staleInbox.id));
    expect(stillFailed.state).toBe("failed");
    expect(stillFailed.attempts).toBe(5);

    // includeExhausted: true resets attempts = 0 and re-arms to 'received'
    const rescued = await requeueFailedPaymentEvents(db, { includeExhausted: true });
    expect(rescued.requeued).toBeGreaterThanOrEqual(1);
    const [rearmed] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, staleInbox.id));
    expect(rearmed.state).toBe("received");
    expect(rearmed.attempts).toBe(0);
    expect(rearmed.error).toBeNull();

    await processPaymentInbox(db, { now });
    const [processedEvt] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, staleInbox.id));
    expect(processedEvt.state).toBe("processed");
    const [capturedIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id));
    expect(capturedIntent.state).toBe("captured");
  });

  it("LND-PRO-008: finance overview surfaces an older chargeback even after 55 newer payment intents", async () => {
    const tenant = await seedTenant(db);
    const { order } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `CB55-${uniquePhone().slice(-6)}`,
    });
    const baseTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const [oldDisputed] = await db.insert(paymentIntents).values({
      organizationId: tenant.organizationId,
      orderId: order.id,
      provider: "fake",
      amountKopeks: 25_000,
      state: "disputed",
      idempotencyKey: `old-cb-${rid()}`,
      createdAt: new Date(baseTime),
    }).returning();

    const newerRows = Array.from({ length: 55 }, (_, i) => ({
      organizationId: tenant.organizationId,
      orderId: order.id,
      provider: "fake",
      amountKopeks: 10_000 + i,
      state: "captured" as const,
      idempotencyKey: `new-pi-${i}-${rid()}`,
      createdAt: new Date(baseTime + (i + 1) * 60_000),
    }));
    await db.insert(paymentIntents).values(newerRows);

    const finance = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/finance/overview",
      headers: { cookie: finance.cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      intents: Array<{ id: string }>;
      intentsMeta: { total: number; hasMore: boolean };
      chargebacks: Array<{ id: string; state: string }>;
      chargebacksMeta: { total: number; hasMore: boolean };
    };

    expect(body.intents).toHaveLength(50);
    expect(body.intents.map(i => i.id)).not.toContain(oldDisputed.id);
    expect(body.intentsMeta).toEqual({ total: 56, hasMore: true });

    expect(body.chargebacks.map(c => c.id)).toContain(oldDisputed.id);
    expect(body.chargebacksMeta).toEqual({ total: 1, hasMore: false });
  });

  it("LND-PRO-011: POST /partner/orders/:id/adjustments rejects negative and zero deltaKopeks at API boundary", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const partner = await seedPartnerForOrder(db, f);
    const partnerSession = await login(app, {
      organizationId: f.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: partner.partnerId,
    });

    for (const deltaKopeks of [-500, 0]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/partner/orders/${f.orderId}/adjustments`,
        headers: { cookie: partnerSession.cookie, "idempotency-key": `adj-${rid()}` },
        payload: { deltaKopeks, reason: "Попытка отрицательной или нулевой корректировки" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("LND-RET-007: RFC-4180 CSV parser handles quoted commas, escaped quotes, and embedded newlines", () => {
    const csv = [
      "id,title,status,role_paths_covered,api_service_evidence,browser_evidence,commit,previous_wave_status,remaining_gap",
      'E2E-010,"Partner dispute, ""quoted"" note",NOT_REVERIFIED_CURRENT_HEAD,partner→finance,"ev1, ev2",None,abc123,PASS,"Line 1\nLine 2"',
    ].join("\r\n");

    const parsed = parseCsv(csv) as string[][];
    expect(parsed).toHaveLength(2);
    expect(parsed[1][1]).toBe('Partner dispute, "quoted" note');
    expect(parsed[1][4]).toBe("ev1, ev2");
    expect(parsed[1][8]).toBe("Line 1\nLine 2");

    const tmpFile = path.join(os.tmpdir(), `csv-test-${rid()}.csv`);
    fs.writeFileSync(tmpFile, csv, "utf8");
    try {
      const map = readPreviousE2eRows(tmpFile) as Map<string, {
        title: string; evidence: string; previousStatus: string; gap: string;
      }>;
      const row = map.get("E2E-010");
      expect(row).toBeDefined();
      expect(row?.title).toBe('Partner dispute, "quoted" note');
      expect(row?.evidence).toBe("ev1, ev2");
      expect(row?.previousStatus).toBe("PASS");
      expect(row?.gap).toBe("Line 1\nLine 2");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
