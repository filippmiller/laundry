import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { partnerCreditNotes, partnerInvoices, partnerPayouts } from "../../src/db/schema.js";
import { login, seedOrder, seedPartner, seedTenant, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 2 finance overview enrichment", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let foreign: Awaited<ReturnType<typeof seedTenant>>;

  let tenantPartnerId: string;
  let foreignPartnerId: string;
  let tenantPayoutId: string;
  let foreignPayoutId: string;
  let tenantCreditNoteId: string;
  let foreignCreditNoteId: string;
  let tenantDeliveredOrderId: string;
  let tenantInspectionOrderId: string;
  let foreignDeliveredOrderId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();

    tenant = await seedTenant(db);
    foreign = await seedTenant(db);

    tenantPartnerId = await seedPartner(db, tenant.organizationId, "Прачечная Альфа");
    foreignPartnerId = await seedPartner(db, foreign.organizationId, "Чужая Прачечная");

    const [tenantPayout] = await db.insert(partnerPayouts).values({
      organizationId: tenant.organizationId,
      partnerId: tenantPartnerId,
      amountKopeks: 25_000,
      state: "scheduled",
      reference: "PAY-W2-1",
      createdBy: tenant.userId,
    }).returning();
    tenantPayoutId = tenantPayout.id;

    const [foreignPayout] = await db.insert(partnerPayouts).values({
      organizationId: foreign.organizationId,
      partnerId: foreignPartnerId,
      amountKopeks: 99_000,
      state: "scheduled",
      reference: "PAY-FOREIGN-1",
      createdBy: foreign.userId,
    }).returning();
    foreignPayoutId = foreignPayout.id;

    const [tenantPartnerInv] = await db.insert(partnerInvoices).values({
      organizationId: tenant.organizationId,
      partnerId: tenantPartnerId,
      number: `PINV-T-${rid().slice(0, 8)}`,
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      totalKopeks: 50_000,
    }).returning();

    const [foreignPartnerInv] = await db.insert(partnerInvoices).values({
      organizationId: foreign.organizationId,
      partnerId: foreignPartnerId,
      number: `PINV-F-${rid().slice(0, 8)}`,
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(),
      totalKopeks: 60_000,
    }).returning();

    const [tenantCn] = await db.insert(partnerCreditNotes).values({
      organizationId: tenant.organizationId,
      invoiceId: tenantPartnerInv.id,
      amountKopeks: 5_000,
      reason: "Корректировка веса",
      state: "draft",
    }).returning();
    tenantCreditNoteId = tenantCn.id;

    const [foreignCn] = await db.insert(partnerCreditNotes).values({
      organizationId: foreign.organizationId,
      invoiceId: foreignPartnerInv.id,
      amountKopeks: 7_000,
      reason: "Чужая корректировка",
      state: "draft",
    }).returning();
    foreignCreditNoteId = foreignCn.id;

    const deliveredRes = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `W2-DEL-${uniquePhone().slice(-6)}`,
      lifecycleState: "delivered",
    });
    tenantDeliveredOrderId = deliveredRes.order.id;

    const inspectionRes = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `W2-INSP-${uniquePhone().slice(-6)}`,
      lifecycleState: "inspection",
    });
    tenantInspectionOrderId = inspectionRes.order.id;

    const foreignDeliveredRes = await seedOrder(db, {
      organizationId: foreign.organizationId,
      customerId: foreign.userId,
      addressId: foreign.addressId,
      tariffVersionId: foreign.catalog.tariffVersionId,
      termsVersion: foreign.catalog.termsVersion,
      publicNumber: `W2-FDEL-${uniquePhone().slice(-6)}`,
      lifecycleState: "delivered",
    });
    foreignDeliveredOrderId = foreignDeliveredRes.order.id;
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("returns partners, partnerPayouts, partnerCreditNotes and deliveredOrders scoped to caller tenant", async () => {
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
      partners: Array<{ id: string; name: string; status: string }>;
      partnerPayouts: Array<{ id: string; partnerId: string; amountKopeks: number; state: string }>;
      partnerCreditNotes: Array<{ id: string; amountKopeks: number; state: string; reason: string }>;
      deliveredOrders: Array<{ id: string; publicNumber: string; lifecycleState: string; createdAt: string }>;
    };

    expect(body.partners.map(p => p.id)).toContain(tenantPartnerId);
    expect(body.partners.map(p => p.id)).not.toContain(foreignPartnerId);
    expect(body.partners.find(p => p.id === tenantPartnerId)).toMatchObject({
      id: tenantPartnerId,
      name: "Прачечная Альфа",
      status: "active",
    });

    expect(body.partnerPayouts.map(p => p.id)).toContain(tenantPayoutId);
    expect(body.partnerPayouts.map(p => p.id)).not.toContain(foreignPayoutId);

    expect(body.partnerCreditNotes.map(c => c.id)).toContain(tenantCreditNoteId);
    expect(body.partnerCreditNotes.map(c => c.id)).not.toContain(foreignCreditNoteId);

    const deliveredIds = body.deliveredOrders.map(o => o.id);
    expect(deliveredIds).toContain(tenantDeliveredOrderId);
    expect(deliveredIds).not.toContain(tenantInspectionOrderId);
    expect(deliveredIds).not.toContain(foreignDeliveredOrderId);
    expect(body.deliveredOrders.find(o => o.id === tenantDeliveredOrderId)).toMatchObject({
      id: tenantDeliveredOrderId,
      lifecycleState: "delivered",
    });
  });

  it("isolates enriched finance overview collections across tenants", async () => {
    const foreignFinance = await login(app, {
      organizationId: foreign.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/finance/overview",
      headers: { cookie: foreignFinance.cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      partners: Array<{ id: string }>;
      partnerPayouts: Array<{ id: string }>;
      partnerCreditNotes: Array<{ id: string }>;
      deliveredOrders: Array<{ id: string }>;
    };

    expect(body.partners.map(p => p.id)).toContain(foreignPartnerId);
    expect(body.partners.map(p => p.id)).not.toContain(tenantPartnerId);

    expect(body.partnerPayouts.map(p => p.id)).toContain(foreignPayoutId);
    expect(body.partnerPayouts.map(p => p.id)).not.toContain(tenantPayoutId);

    expect(body.partnerCreditNotes.map(c => c.id)).toContain(foreignCreditNoteId);
    expect(body.partnerCreditNotes.map(c => c.id)).not.toContain(tenantCreditNoteId);

    expect(body.deliveredOrders.map(o => o.id)).toContain(foreignDeliveredOrderId);
    expect(body.deliveredOrders.map(o => o.id)).not.toContain(tenantDeliveredOrderId);
  });
});
