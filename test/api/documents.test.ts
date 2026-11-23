import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { login, seedInvoice, seedOrder, seedTenant, uniquePhone } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("GET /documents/:kind/:id", () => {
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
      publicNumber: `DOC-${uniquePhone().slice(-6)}`,
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

  it("renders the own customer invoice with an explicit non fiscal warning", async () => {
    const customer = await login(app, {
      organizationId: tenant.organizationId, phone: tenant.phone, roles: ["customer"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/customer_invoice/${invoiceId}`,
      headers: { cookie: customer.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      kind: string;
      number: string;
      totalKopeks: number;
      disclaimer: string;
      orderPublicNumber?: string;
      lines: Array<{ name: string; qty: number; unit: string; amountKopeks: number }>;
    };
    expect(body.kind).toBe("customer_invoice");
    expect(body.totalKopeks).toBe(10000);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(typeof body.disclaimer).toBe("string");
    expect(body.disclaimer.length).toBeGreaterThan(0);
    expect(body.orderPublicNumber).toBeDefined();
  });

  it("refuses a role that may not read documents", async () => {
    const courier = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["courier"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/customer_invoice/${invoiceId}`,
      headers: { cookie: courier.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("hides the document of another customer of the same tenant", async () => {
    const stranger = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/customer_invoice/${invoiceId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("hides the document from another tenant", async () => {
    const foreignCustomer = await login(app, {
      organizationId: foreign.organizationId, phone: foreign.phone, roles: ["customer"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/customer_invoice/${invoiceId}`,
      headers: { cookie: foreignCustomer.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses an unauthenticated call", async () => {
    const response = await app.inject({
      method: "GET", url: `/api/v1/documents/customer_invoice/${invoiceId}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an unknown document kind and a malformed id", async () => {
    const customer = await login(app, {
      organizationId: tenant.organizationId, phone: tenant.phone, roles: ["customer"],
    });
    const wrongKind = await app.inject({
      method: "GET",
      url: `/api/v1/documents/invoice/${invoiceId}`,
      headers: { cookie: customer.cookie },
    });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().error.code).toBe("VALIDATION_ERROR");

    const wrongId = await app.inject({
      method: "GET",
      url: "/api/v1/documents/customer_invoice/not-a-uuid",
      headers: { cookie: customer.cookie },
    });
    expect(wrongId.statusCode).toBe(400);
    expect(wrongId.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("answers NOT_FOUND for a document that does not exist", async () => {
    const customer = await login(app, {
      organizationId: tenant.organizationId, phone: tenant.phone, roles: ["customer"],
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/documents/intake_receipt/${randomUUID()}`,
      headers: { cookie: customer.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("publishes the route in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/documents/:kind/:id"]?.get).toBeDefined();
  });
});
