import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { login, seedInvoice, seedOrder, seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("GET /finance/overview", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let foreign: Awaited<ReturnType<typeof seedTenant>>;
  let invoiceId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
    foreign = await seedTenant(db);
    const { order } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `OV-${uniquePhone().slice(-6)}`,
    });
    const invoice = await seedInvoice(db, {
      organizationId: tenant.organizationId,
      orderId: order.id,
      number: `INV-${uniquePhone().slice(-6)}`,
    });
    invoiceId = invoice.id;
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("returns the finance aggregate of the caller's own tenant", async () => {
    const finance = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["platform_finance"],
    });
    const response = await app.inject({
      method: "GET", url: "/api/v1/finance/overview", headers: { cookie: finance.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      invoices: Array<{ id: string }>;
      intents: unknown[];
      refunds: unknown[];
      partnerInvoices: unknown[];
      pendingCompensations: unknown[];
      fiscalReceipts: unknown[];
      chargebacks: unknown[];
      drift: unknown[];
    };
    expect(body.invoices.map(invoice => invoice.id)).toContain(invoiceId);
    expect(Array.isArray(body.intents)).toBe(true);
    expect(Array.isArray(body.refunds)).toBe(true);
    expect(Array.isArray(body.partnerInvoices)).toBe(true);
    expect(Array.isArray(body.pendingCompensations)).toBe(true);
    expect(Array.isArray(body.fiscalReceipts)).toBe(true);
    expect(Array.isArray(body.chargebacks)).toBe(true);
    expect(Array.isArray(body.drift)).toBe(true);
  });

  it("refuses a customer", async () => {
    const customer = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
    });
    const response = await app.inject({
      method: "GET", url: "/api/v1/finance/overview", headers: { cookie: customer.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("never leaks the rows of another tenant", async () => {
    const foreignFinance = await login(app, {
      organizationId: foreign.organizationId, phone: uniquePhone(), roles: ["platform_finance"],
    });
    const response = await app.inject({
      method: "GET", url: "/api/v1/finance/overview", headers: { cookie: foreignFinance.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { invoices: Array<{ id: string }> };
    expect(body.invoices.map(invoice => invoice.id)).not.toContain(invoiceId);
  });

  it("refuses an unauthenticated call", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/finance/overview" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("publishes the route in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/finance/overview"]?.get).toBeDefined();
  });
});
