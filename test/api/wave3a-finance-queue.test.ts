import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { partnerCreditNotes, partnerInvoices, partnerPayouts } from "../../src/db/schema.js";
import { login, seedPartner, seedTenant, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3A finance queue prioritization", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;

  let partnerId: string;
  let oldScheduledPayoutId: string;
  let oldDraftCreditNoteId: string;
  const newerPayoutIds: string[] = [];
  const newerCreditNoteIds: string[] = [];

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();

    tenant = await seedTenant(db);
    partnerId = await seedPartner(db, tenant.organizationId, "Прачечная Очередь");

    const baseTime = Date.now() - 10 * 24 * 60 * 60 * 1000;

    // 1 old scheduled payout + 50 newer approved/paid payouts
    const [oldPayout] = await db.insert(partnerPayouts).values({
      organizationId: tenant.organizationId,
      partnerId,
      amountKopeks: 15_000,
      state: "scheduled",
      reference: "OLD-SCHEDULED-1",
      createdBy: tenant.userId,
      createdAt: new Date(baseTime),
    }).returning();
    oldScheduledPayoutId = oldPayout.id;

    const payoutRows = Array.from({ length: 50 }, (_, idx) => ({
      organizationId: tenant.organizationId,
      partnerId,
      amountKopeks: 10_000 + idx,
      state: idx % 2 === 0 ? "approved" : "paid",
      reference: `HIST-PAY-${idx + 1}`,
      createdBy: tenant.userId,
      createdAt: new Date(baseTime + (idx + 1) * 60_000),
    }));
    const insertedPayouts = await db.insert(partnerPayouts).values(payoutRows).returning({ id: partnerPayouts.id });
    newerPayoutIds.push(...insertedPayouts.map(r => r.id));

    const [partnerInv] = await db.insert(partnerInvoices).values({
      organizationId: tenant.organizationId,
      partnerId,
      number: `PINV-Q-${rid().slice(0, 8)}`,
      periodStart: new Date(baseTime - 86_400_000),
      periodEnd: new Date(baseTime),
      totalKopeks: 500_000,
    }).returning();

    // 1 old draft credit note + 50 newer approved credit notes
    const [oldCreditNote] = await db.insert(partnerCreditNotes).values({
      organizationId: tenant.organizationId,
      invoiceId: partnerInv.id,
      amountKopeks: 2_500,
      reason: "Старый черновик кредит-ноты",
      state: "draft",
      createdAt: new Date(baseTime),
    }).returning();
    oldDraftCreditNoteId = oldCreditNote.id;

    const creditNoteRows = Array.from({ length: 50 }, (_, idx) => ({
      organizationId: tenant.organizationId,
      invoiceId: partnerInv.id,
      amountKopeks: 1_000 + idx,
      reason: `Одобренная кредит-нота #${idx + 1}`,
      state: "approved",
      approvedBy: tenant.userId,
      createdAt: new Date(baseTime + (idx + 1) * 60_000),
    }));
    const insertedCreditNotes = await db.insert(partnerCreditNotes)
      .values(creditNoteRows)
      .returning({ id: partnerCreditNotes.id });
    newerCreditNoteIds.push(...insertedCreditNotes.map(r => r.id));
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("always includes older scheduled payouts and draft credit notes ahead of 50 newer settled/approved rows", async () => {
    const finance = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/finance/overview",
      headers: { cookie: finance.cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      partnerPayouts: Array<{ id: string; state: string }>;
      partnerCreditNotes: Array<{ id: string; state: string }>;
    };

    expect(newerPayoutIds.length).toBe(50);
    expect(newerCreditNoteIds.length).toBe(50);

    expect(body.partnerPayouts.map(p => p.id)).toContain(oldScheduledPayoutId);
    expect(body.partnerPayouts[0]?.id).toBe(oldScheduledPayoutId);
    expect(body.partnerPayouts.length).toBe(50);

    expect(body.partnerCreditNotes.map(c => c.id)).toContain(oldDraftCreditNoteId);
    expect(body.partnerCreditNotes[0]?.id).toBe(oldDraftCreditNoteId);
    expect(body.partnerCreditNotes.length).toBe(50);
  });

  it("returns DUAL_CONTROL_REQUIRED in error.message when the payout creator attempts to approve it", async () => {
    const creatorFinance = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/finance/partner-payouts",
      headers: {
        cookie: creatorFinance.cookie,
        "idempotency-key": `w3a-pay-${rid()}`,
      },
      payload: {
        partnerId,
        amountKopeks: 12_000,
        reference: "W3A-DUAL-CTRL",
      },
    });
    expect(createRes.statusCode).toBe(200);
    const { payoutId } = createRes.json() as { payoutId: string };

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-payouts/${payoutId}/approve`,
      headers: {
        cookie: creatorFinance.cookie,
        "idempotency-key": `w3a-app-${rid()}`,
      },
      payload: {},
    });
    expect(approveRes.statusCode).toBe(403);
    expect(approveRes.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "DUAL_CONTROL_REQUIRED",
      },
    });
  });
});
