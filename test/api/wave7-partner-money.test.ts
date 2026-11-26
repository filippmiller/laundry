import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  orderLines, partnerDisputes, partnerInvoiceLines, partnerInvoices, partnerServiceAccruals,
} from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartner } from "../operations-fixtures.js";
import {
  approvePartnerPayout, createPartnerPayout, listPartnerDisputes, listPartnerScopedDisputes,
  partnerAccruals, resolvePartnerDispute,
} from "../../src/services/finance.js";
import { queryPartnerBalance } from "../../src/services/partner-payable.js";
import { login, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: partner money balance and dispute reachability (LND-R4-03, LND-R4-02)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
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

  /**
   * A partner with `accrualCount` accruals of `amountKopeks` each, billed on one invoice with
   * one line per accrual. The invoice lines are the rows a dispute can hang on.
   */
  async function seedAccruedPartner(options: { accrualCount: number; amountKopeks: number }) {
    const order = await seedFullOrder(db);
    const partner = await seedPartner(db, order.organizationId);
    const [orderLine] = await db.select({ id: orderLines.id }).from(orderLines)
      .where(eq(orderLines.orderId, order.orderId)).limit(1);
    expect(orderLine).toBeDefined();
    const accruals = await db.insert(partnerServiceAccruals).values(
      Array.from({ length: options.accrualCount }, () => ({
        organizationId: order.organizationId,
        partnerId: partner.partnerId,
        orderLineId: orderLine.id,
        contractId: partner.contractId,
        contractPriceVersionId: partner.priceVersionId,
        quantity: 1,
        amountKopeks: options.amountKopeks,
        status: "accrued",
      })),
    ).returning();
    const [invoice] = await db.insert(partnerInvoices).values({
      organizationId: order.organizationId,
      partnerId: partner.partnerId,
      number: `PINV-${rid().slice(0, 8)}`,
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      totalKopeks: options.accrualCount * options.amountKopeks,
    }).returning();
    const lines = await db.insert(partnerInvoiceLines).values(
      accruals.map(accrual => ({
        invoiceId: invoice.id, accrualId: accrual.id, amountKopeks: options.amountKopeks,
      })),
    ).returning();
    const finance = makePrincipal(order.organizationId, await seedUser(db, order.organizationId), ["platform_finance"]);
    return { ...order, partner, finance, accruals, invoice, lines };
  }

  it("LND-R4-02: a dispute behind the first page is reachable and the list reports the total", async () => {
    const fixture = await seedAccruedPartner({ accrualCount: 51, amountKopeks: 1000 });
    // The disputes are opened one minute apart, so "newest first" is a stable order.
    const base = new Date("2026-01-01T00:00:00.000Z");
    const disputes = (await db.insert(partnerDisputes).values(
      fixture.lines.map((line, index) => ({
        organizationId: fixture.organizationId,
        invoiceLineId: line.id,
        openedBy: fixture.finance.userId,
        reason: `Спор №${index + 1}`,
        state: "open" as const,
        openedAt: new Date(base.getTime() + index * 60_000),
      })),
    ).returning()).sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());

    // The newest 45 disputes are settled; the six oldest ones stay open. The oldest open
    // dispute is the one that used to fall off the end of the first page.
    const openDisputes = disputes.slice(0, 6);
    for (const dispute of disputes.slice(6)) {
      await resolvePartnerDispute(db, fixture.finance, {
        disputeId: dispute.id,
        outcome: "rejected",
        reason: "Спор не подтвердился приёмкой.",
        key: `resolve-${rid()}`,
      });
    }
    const oldestOpen = openDisputes[0];

    const page1 = await listPartnerDisputes(db, fixture.finance, { limit: 50 });
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.totalCount).toBe(51);

    // The cursor leads to the oldest dispute, and the total still counts the whole set.
    const page2 = await listPartnerDisputes(db, fixture.finance, { limit: 50, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe(oldestOpen.id);
    expect(page2.items[0].state).toBe("open");
    expect(page2.totalCount).toBe(51);

    // The state filter reaches it too, and counts only what it matched.
    const open = await listPartnerDisputes(db, fixture.finance, { state: "open", limit: 100 });
    expect(open.items.map(item => item.id)).toContain(oldestOpen.id);
    expect(open.totalCount).toBe(6);

    // "resolved" is the alias of the rejected state: the settled disputes are counted there.
    const resolved = await listPartnerDisputes(db, fixture.finance, { state: "resolved", limit: 100 });
    expect(resolved.totalCount).toBe(45);
    expect(resolved.items.map(item => item.id)).not.toContain(oldestOpen.id);

    // The partner sees the same set, scoped to its own lines.
    const scoped = await listPartnerScopedDisputes(db, fixture.partner.principal, { state: "open", limit: 100 });
    expect(scoped.items.map(item => item.id)).toContain(oldestOpen.id);
    expect(scoped.totalCount).toBe(6);
  });

  it("LND-R4-02: the partner dispute route honours the state, limit and cursor of the query string", async () => {
    const fixture = await seedAccruedPartner({ accrualCount: 51, amountKopeks: 1000 });
    const base = new Date("2026-01-01T00:00:00.000Z");
    const disputes = (await db.insert(partnerDisputes).values(
      fixture.lines.map((line, index) => ({
        organizationId: fixture.organizationId,
        invoiceLineId: line.id,
        openedBy: fixture.finance.userId,
        reason: `Спор маршрута №${index + 1}`,
        state: "open" as const,
        openedAt: new Date(base.getTime() + index * 60_000),
      })),
    ).returning()).sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());
    const oldestOpen = disputes[0];

    const session = await login(app, {
      organizationId: fixture.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: fixture.partner.partnerId,
    });
    expect(session.status).toBe(200);

    // The route used to ignore the query string entirely: no filter, no page, no total.
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/partner/disputes?state=open&limit=2",
      headers: { cookie: session.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { items: Array<{ id: string }>; nextCursor: string | null; totalCount: number };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.totalCount).toBe(51);
    expect(firstBody.nextCursor).toBeTruthy();

    // Walking the cursor reaches the oldest dispute of the tenant.
    const seen: string[] = [];
    let cursor: string | null = firstBody.nextCursor;
    for (let page = 0; page < 40 && cursor; page += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/partner/disputes?state=open&limit=2&cursor=${encodeURIComponent(cursor)}`,
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: Array<{ id: string }>; nextCursor: string | null; totalCount: number };
      expect(body.totalCount).toBe(51);
      seen.push(...body.items.map(item => item.id));
      cursor = body.nextCursor;
    }
    expect(seen).toContain(oldestOpen.id);
    expect(new Set(seen).size).toBe(49);
  });

  it("LND-R4-03: the partner balance subtracts paid and reserved payouts, and the panel reads it", async () => {
    const fixture = await seedAccruedPartner({ accrualCount: 1, amountKopeks: 100_000 });
    const approver = makePrincipal(fixture.organizationId, await seedUser(db, fixture.organizationId), ["platform_finance"]);

    const before = await queryPartnerBalance(db, fixture.organizationId, fixture.partner.partnerId);
    expect(before.accruedKopeks).toBe(100_000);
    expect(before.disputedKopeks).toBe(0);
    expect(before.grossPayableKopeks).toBe(100_000);
    expect(before.paidKopeks).toBe(0);
    expect(before.reservedKopeks).toBe(0);
    expect(before.availableKopeks).toBe(100_000);

    // A scheduled payout reserves the money; it is not paid out yet.
    const payout = await createPartnerPayout(db, fixture.finance, {
      partnerId: fixture.partner.partnerId,
      amountKopeks: 60_000,
      reference: "PAY-W7",
      key: `payout-${rid()}`,
    });
    const scheduled = await queryPartnerBalance(db, fixture.organizationId, fixture.partner.partnerId);
    expect(scheduled.reservedKopeks).toBe(60_000);
    expect(scheduled.paidKopeks).toBe(0);
    expect(scheduled.availableKopeks).toBe(40_000);

    // Once approved the reservation becomes a payment.
    await approvePartnerPayout(db, approver, { payoutId: payout.payoutId, key: `approve-${rid()}` });
    const balance = await queryPartnerBalance(db, fixture.organizationId, fixture.partner.partnerId);
    expect(balance.accruedKopeks).toBe(100_000);
    expect(balance.disputedKopeks).toBe(0);
    expect(balance.grossPayableKopeks).toBe(100_000);
    expect(balance.paidKopeks).toBe(60_000);
    expect(balance.reservedKopeks).toBe(0);
    expect(balance.availableKopeks).toBe(40_000);

    // The panel of the partner carries the very same numbers.
    const accruals = await partnerAccruals(db, fixture.partner.principal, {});
    expect(accruals.balance.accruedKopeks).toBe(100_000);
    expect(accruals.balance.paidKopeks).toBe(60_000);
    expect(accruals.balance.reservedKopeks).toBe(0);
    expect(accruals.balance.availableKopeks).toBe(40_000);
    expect(accruals.payableKopeks).toBe(accruals.balance.grossPayableKopeks);
    expect(accruals.estimatedTotalKopeks).toBe(100_000);

    const session = await login(app, {
      organizationId: fixture.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: fixture.partner.partnerId,
    });
    expect(session.status).toBe(200);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/partner/accruals",
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      balance: { accruedKopeks: number; paidKopeks: number; reservedKopeks: number; availableKopeks: number };
    };
    expect(body.balance.accruedKopeks).toBe(100_000);
    expect(body.balance.paidKopeks).toBe(60_000);
    expect(body.balance.reservedKopeks).toBe(0);
    expect(body.balance.availableKopeks).toBe(40_000);

    // The payout authorization reads the same balance: 40 000 is all that is left.
    await expect(createPartnerPayout(db, fixture.finance, {
      partnerId: fixture.partner.partnerId,
      amountKopeks: 50_000,
      key: `payout-too-much-${rid()}`,
    })).rejects.toMatchObject({ code: "FINANCIAL_HOLD", message: "PAYOUT_EXCEEDS_PAYABLE" });
  });

  it("LND-R4-03: the accrued total does not stop at the end of the accrual page", async () => {
    const fixture = await seedAccruedPartner({ accrualCount: 51, amountKopeks: 1000 });
    const accruals = await partnerAccruals(db, fixture.partner.principal, { limit: 50 });
    expect(accruals.accruals).toHaveLength(50);
    // The whole history, not the 50 rows of the page.
    expect(accruals.estimatedTotalKopeks).toBe(51_000);
    expect(accruals.balance.accruedKopeks).toBe(51_000);
    expect(accruals.balance.grossPayableKopeks).toBe(51_000);
    expect(accruals.balance.availableKopeks).toBe(51_000);
    expect(accruals.payableKopeks).toBe(51_000);
  });
});
