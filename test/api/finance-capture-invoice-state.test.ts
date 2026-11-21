import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { customerInvoices, paymentIntents } from "../../src/db/schema.js";
import { login, seedInvoice, seedOrder, seedTenant, uniquePhone } from "./_fixtures.js";

/**
 * A voided invoice must never be capturable.
 *
 * When a partner returns an order unprocessed, the open customer invoice is cancelled
 * (`src/services/partner.ts`). Before this guard existed, `capturePayment` selected the
 * invoice of an order without looking at its state, so a finance-initiated capture against
 * a cancelled invoice was accepted and the customer became payable for an order that was
 * never processed.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /finance/payments/capture — invoice state", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let openOrderId: string;
  let voidedOrderId: string;
  let openInvoiceId: string;
  let voidedInvoiceId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);

    const open = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `OPEN-${uniquePhone().slice(-6)}`,
    });
    openOrderId = open.order.id;
    const openInvoice = await seedInvoice(db, {
      organizationId: tenant.organizationId, orderId: openOrderId, number: `INV-OPEN-${uniquePhone().slice(-6)}`,
    });
    openInvoiceId = openInvoice.id;

    const voided = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `VOID-${uniquePhone().slice(-6)}`,
    });
    voidedOrderId = voided.order.id;
    const voidedInvoice = await seedInvoice(db, {
      organizationId: tenant.organizationId, orderId: voidedOrderId, number: `INV-VOID-${uniquePhone().slice(-6)}`,
    });
    voidedInvoiceId = voidedInvoice.id;
    await db.update(customerInvoices).set({ state: "cancelled" }).where(eq(customerInvoices.id, voidedInvoiceId));
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function finance() {
    return login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });
  }

  async function capturedIntents(orderId: string) {
    return db.select().from(paymentIntents).where(eq(paymentIntents.orderId, orderId));
  }

  it("captures an open invoice", async () => {
    const session = await finance();
    expect(session.status).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/finance/payments/capture",
      headers: { cookie: session.cookie, "idempotency-key": `cap-open-${uniquePhone().slice(-8)}` },
      payload: { orderId: openOrderId, amountKopeks: 10000 },
    });

    expect(response.statusCode).toBe(200);
    expect((await capturedIntents(openOrderId)).length).toBe(1);
  });

  it("refuses to capture a voided invoice and creates no payment intent", async () => {
    const session = await finance();
    expect(session.status).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/finance/payments/capture",
      headers: { cookie: session.cookie, "idempotency-key": `cap-void-${uniquePhone().slice(-8)}` },
      payload: { orderId: voidedOrderId, amountKopeks: 10000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("FINANCIAL_HOLD");
    expect(response.json().error.message).toBe("INVOICE_NOT_PAYABLE");
    expect(await capturedIntents(voidedOrderId)).toHaveLength(0);
  });

  it("refuses to capture a voided invoice for the customer as well", async () => {
    // The customer of the order itself: a customer of somebody else never reaches the invoice.
    const session = await login(app, {
      organizationId: tenant.organizationId,
      phone: tenant.phone,
      roles: ["customer"],
    });
    expect(session.status).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/finance/payments/capture",
      headers: { cookie: session.cookie, "idempotency-key": `cap-void-cust-${uniquePhone().slice(-8)}` },
      payload: { orderId: voidedOrderId, amountKopeks: 10000 },
    });

    expect(response.statusCode).toBe(409);
    expect(await capturedIntents(voidedOrderId)).toHaveLength(0);
  });

  it("keeps the invoice of the captured order payable exactly once", async () => {
    const session = await finance();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/finance/payments/capture",
      headers: { cookie: session.cookie, "idempotency-key": `cap-open-2-${uniquePhone().slice(-8)}` },
      payload: { orderId: openOrderId, amountKopeks: 10000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("FINANCIAL_HOLD");
    expect((await capturedIntents(openOrderId)).length).toBe(1);
    const [invoice] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, openInvoiceId));
    expect(invoice?.state).toBe("paid");
  });
});
