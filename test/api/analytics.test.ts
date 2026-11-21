import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { eq } from "drizzle-orm";
import {
  customerInvoices, garments, intakeManifests, orderLines, paymentIntents, refunds,
} from "../../src/db/schema.js";
import { normalizeCategory } from "../../src/services/item-mix.js";
import { login, seedGarment, seedInvoice, seedOrder, seedPartner, seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Money and volume analytics", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let foreign: Awaited<ReturnType<typeof seedTenant>>;
  let invoiceId: string;
  let invoiceNumber: string;
  let orderId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
    foreign = await seedTenant(db);

    const seeded = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `AN-${uniquePhone().slice(-6)}`,
    });
    orderId = seeded.order.id;

    const invoice = await seedInvoice(db, {
      organizationId: tenant.organizationId,
      orderId,
      number: `INV-${uniquePhone().slice(-6)}`,
      totalKopeks: 10_000,
    });
    invoiceId = invoice.id;
    invoiceNumber = invoice.number;

    // A gram-priced line and a manifest that is lighter than the quote: the weight variance the
    // operations panel reports.
    await db.insert(orderLines).values({
      orderId,
      serviceId: tenant.catalog.serviceId,
      tier: "economy",
      quotedQuantity: 2_000,
      unit: "gram",
      quotedAmountKopeks: 10_000,
      tariffSnapshotJson: {},
    });
    await db.insert(intakeManifests).values({
      organizationId: tenant.organizationId,
      orderId,
      mode: "economy_bag",
      count: 1,
      weightGrams: 1_500,
      manifestHash: "m".repeat(64),
      state: "accepted",
    });

    // Two protected items whose categories differ only by wording.
    await seedGarment(db, {
      organizationId: tenant.organizationId,
      orderId,
      itemCode: `TEE-${uniquePhone().slice(-6)}`,
    });
    await db.insert(garments).values({
      organizationId: tenant.organizationId,
      orderId,
      itemCode: `TEE2-${uniquePhone().slice(-6)}`,
      category: "Футболки",
      description: "Футболка чёрная",
    });
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function financeCookie(organizationId: string, phone = uniquePhone()) {
    const session = await login(app, { organizationId, phone, roles: ["platform_finance"] });
    return session.cookie;
  }

  describe("GET /finance/analytics", () => {
    it("reports what customers owe, what we owe partners and the contribution", async () => {
      const cookie = await financeCookie(tenant.organizationId);
      const response = await app.inject({
        method: "GET", url: "/api/v1/finance/analytics", headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        receivables: { invoicedKopeks: number; receivableKopeks: number; invoiceCount: number; openInvoices: Array<{ invoiceNumber: string }> };
        payables: { accruedKopeks: number; payableKopeks: number };
        margin: { netCollectedKopeks: number; contributionKopeks: number; takeRate: number | null; note: string };
        exposure: { compensationsApprovedKopeks: number };
      };

      expect(body.receivables.invoicedKopeks).toBeGreaterThanOrEqual(10_000);
      expect(body.receivables.invoiceCount).toBe(1);
      // The invoice was never captured, so the whole amount is still owed.
      expect(body.receivables.receivableKopeks).toBeGreaterThanOrEqual(10_000);
      expect(body.receivables.openInvoices.map(row => row.invoiceNumber)).toContain(invoiceNumber);
      // No partner accrual exists yet, and the margin note never claims a profit.
      expect(body.payables.accruedKopeks).toBe(0);
      expect(body.margin.takeRate).toBeNull();
      expect(body.margin.note).toMatch(/не прибыль/);
    });

    it("turns a captured invoice into collected money and a refund into a credit", async () => {
      const [intent] = await db.insert(paymentIntents).values({
        organizationId: tenant.organizationId,
        orderId,
        provider: "fake",
        amountKopeks: 10_000,
        state: "captured",
        idempotencyKey: `cap-${uniquePhone()}`,
      }).returning();
      await db.insert(refunds).values({
        organizationId: tenant.organizationId,
        paymentIntentId: intent.id,
        amountKopeks: 4_000,
        state: "completed",
        reason: "тест",
        idempotencyKey: `ref-${uniquePhone()}`,
      });
      await db.update(paymentIntents).set({ state: "partially_refunded" }).where(eq(paymentIntents.id, intent.id));

      const cookie = await financeCookie(tenant.organizationId);
      const body = (await app.inject({
        method: "GET", url: "/api/v1/finance/analytics", headers: { cookie },
      })).json() as {
        receivables: { netCollectedKopeks: number; refundedKopeks: number; receivableKopeks: number };
      };

      expect(body.receivables.netCollectedKopeks).toBe(6_000);
      expect(body.receivables.refundedKopeks).toBe(4_000);
      expect(body.receivables.receivableKopeks).toBe(4_000);
    });

    it("never leaks another tenant's money", async () => {
      const cookie = await financeCookie(foreign.organizationId);
      const body = (await app.inject({
        method: "GET", url: "/api/v1/finance/analytics", headers: { cookie },
      })).json() as { receivables: { invoiceCount: number; openInvoices: Array<{ invoiceNumber: string }> } };
      expect(body.receivables.invoiceCount).toBe(0);
      expect(body.receivables.openInvoices).toHaveLength(0);
    });

    it("refuses a customer and an unauthenticated call", async () => {
      const customer = await login(app, {
        organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
      });
      const refused = await app.inject({
        method: "GET", url: "/api/v1/finance/analytics", headers: { cookie: customer.cookie },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("FORBIDDEN");

      const anonymous = await app.inject({ method: "GET", url: "/api/v1/finance/analytics" });
      expect(anonymous.statusCode).toBe(401);
    });

    it("publishes the route in the OpenAPI document", async () => {
      const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(spec.paths["/finance/analytics"]?.get).toBeDefined();
    });
  });

  describe("GET /customer/finance", () => {
    it("shows the customer their own spend and what they still owe", async () => {
      const session = await login(app, {
        organizationId: tenant.organizationId, phone: tenant.phone, roles: ["customer"],
      });
      const response = await app.inject({
        method: "GET", url: "/api/v1/customer/finance", headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        totals: { orderCount: number; chargedKopeks: number; outstandingKopeks: number };
        orders: Array<{ publicNumber: string; outstandingKopeks: number }>;
        byService: Array<{ serviceName: string; tier: string }>;
      };
      expect(body.totals.orderCount).toBeGreaterThanOrEqual(1);
      expect(body.totals.chargedKopeks).toBeGreaterThan(0);
      expect(body.orders.some(order => order.outstandingKopeks > 0)).toBe(true);
      expect(body.byService.some(row => row.serviceName === "Стирка")).toBe(true);
    });

    it("never shows a customer another customer's orders", async () => {
      const stranger = await login(app, {
        organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
      });
      const body = (await app.inject({
        method: "GET", url: "/api/v1/customer/finance", headers: { cookie: stranger.cookie },
      })).json() as { totals: { orderCount: number } };
      expect(body.totals.orderCount).toBe(0);
    });

    it("refuses a finance role", async () => {
      const cookie = await financeCookie(tenant.organizationId);
      const response = await app.inject({
        method: "GET", url: "/api/v1/customer/finance", headers: { cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("publishes the route in the OpenAPI document", async () => {
      const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(spec.paths["/customer/finance"]?.get).toBeDefined();
    });
  });

  describe("GET /ops/item-mix", () => {
    it("counts items by category and measures the weight against the quote", async () => {
      const session = await login(app, {
        organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["dispatcher"],
      });
      const response = await app.inject({
        method: "GET", url: "/api/v1/ops/item-mix?days=90", headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        categories: Array<{ category: string; itemCount: number; rawCategories: string[] }>;
        weight: { quotedGrams: number; receivedGrams: number; deltaGrams: number; ordersWithUnderReceipt: number };
        tierSplit: { protected: { itemCount: number } };
        note: string;
      };

      // The two items are "бытовая" (unknown) and "Футболки" (a known synonym of футболка).
      const known = body.categories.find(row => row.category === "футболка");
      expect(known?.itemCount).toBe(1);
      expect(known?.rawCategories).toContain("Футболки");
      expect(body.tierSplit.protected.itemCount).toBe(2);

      expect(body.weight.quotedGrams).toBe(2_000);
      expect(body.weight.receivedGrams).toBe(1_500);
      expect(body.weight.deltaGrams).toBe(-500);
      expect(body.weight.ordersWithUnderReceipt).toBe(1);
      expect(body.note).toMatch(/Эконом/);
    });

    it("limits a laundry partner to its own book of orders", async () => {
      const partnerId = await seedPartner(db, tenant.organizationId, "Прачечная теста");
      const session = await login(app, {
        organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId,
      });
      const body = (await app.inject({
        method: "GET", url: "/api/v1/ops/item-mix?days=90", headers: { cookie: session.cookie },
      })).json() as { categories: Array<{ itemCount: number }> };
      expect(body.categories).toHaveLength(0);
    });

    it("refuses a customer", async () => {
      const customer = await login(app, {
        organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
      });
      const response = await app.inject({
        method: "GET", url: "/api/v1/ops/item-mix", headers: { cookie: customer.cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("publishes the route in the OpenAPI document", async () => {
      const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(spec.paths["/ops/item-mix"]?.get).toBeDefined();
    });
  });

  describe("category vocabulary", () => {
    it("folds synonyms onto one category and never guesses", () => {
      expect(normalizeCategory("Футболка")).toBe("футболка");
      expect(normalizeCategory("  футболки ")).toBe("футболка");
      expect(normalizeCategory("T-shirt")).toBe("футболка");
      expect(normalizeCategory("JEANS")).toBe("джинсы");
      expect(normalizeCategory("Платье")).toBe("платье");
      expect(normalizeCategory("неизвестная вещь")).toBe("прочее");
      expect(normalizeCategory("")).toBe("прочее");
    });
  });

  it("keeps the customer invoice untouched by the analytics reads", async () => {
    const [invoice] = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.id, invoiceId)).limit(1);
    expect(invoice.totalKopeks).toBe(10_000);
  });
});
