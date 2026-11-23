import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { garments, orders, serviceWindows, slotReservations } from "../../src/db/schema.js";
import {
  login, seedGarment, seedOrder, seedPartner, seedReservation, seedTenant, uniquePhone,
} from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("POST /partner/orders/:id/return-unprocessed", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let foreign: Awaited<ReturnType<typeof seedTenant>>;
  let partnerId: string;
  let otherPartnerId: string;
  let orderId: string;
  let garmentId: string;
  let reservationId: string;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    tenant = await seedTenant(db);
    foreign = await seedTenant(db);
    partnerId = await seedPartner(db, tenant.organizationId, "Прачечка №1");
    otherPartnerId = await seedPartner(db, tenant.organizationId, "Прачечка №2");
    const { order } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `RET-${uniquePhone().slice(-6)}`,
      lifecycleState: "inspection",
      assignedPartnerId: partnerId,
    });
    orderId = order.id;
    garmentId = await seedGarment(db, {
      organizationId: tenant.organizationId, orderId, itemCode: `G-${uniquePhone().slice(-8)}`,
    });
    reservationId = await seedReservation(db, {
      organizationId: tenant.organizationId,
      windowId: tenant.windowId,
      orderId,
      principalId: tenant.userId,
      key: `res-${uniquePhone().slice(-8)}`,
    });
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function assignedPartner() {
    return login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId,
    });
  }

  it("returns the order unprocessed, releases the capacity and charges nothing", async () => {
    const partner = await assignedPartner();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { cookie: partner.cookie, "idempotency-key": `return-${uniquePhone()}` },
      payload: { reason: "Клиент отказался от цены" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ orderId, state: "ready" });

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(order.lifecycleState).toBe("ready");
    expect(order.returnReason).toBe("Клиент отказался от цены");
    const [garment] = await db.select().from(garments).where(eq(garments.id, garmentId)).limit(1);
    expect(garment.status).toBe("returned_unprocessed");
    const [reservation] = await db.select().from(slotReservations).where(eq(slotReservations.id, reservationId)).limit(1);
    expect(reservation.state).toBe("released");
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, tenant.windowId)).limit(1);
    expect(window.reservedOrders).toBe(0);
  });

  it("refuses a customer", async () => {
    const customer = await login(app, {
      organizationId: tenant.organizationId, phone: uniquePhone(), roles: ["customer"],
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { cookie: customer.cookie, "idempotency-key": `return-c-${uniquePhone()}` },
      payload: { reason: "Клиент отказался от цены" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("hides the order from a partner that is not assigned to it", async () => {
    const stranger = await login(app, {
      organizationId: tenant.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: otherPartnerId,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { cookie: stranger.cookie, "idempotency-key": `return-s-${uniquePhone()}` },
      payload: { reason: "Клиент отказался от цены" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("hides the order from another tenant", async () => {
    const foreignPartner = await login(app, {
      organizationId: foreign.organizationId,
      phone: uniquePhone(),
      roles: ["laundry_operator"],
      partnerId: await seedPartner(db, foreign.organizationId, "Чужая прачечка"),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { cookie: foreignPartner.cookie, "idempotency-key": `return-f-${uniquePhone()}` },
      payload: { reason: "Клиент отказался от цены" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses an unauthenticated call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { "idempotency-key": `return-u-${uniquePhone()}` },
      payload: { reason: "Клиент отказался от цены" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed body", async () => {
    const partner = await assignedPartner();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderId}/return-unprocessed`,
      headers: { cookie: partner.cookie, "idempotency-key": `return-m-${uniquePhone()}` },
      payload: { reason: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("is idempotent under one key", async () => {
    const { order } = await seedOrder(db, {
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      addressId: tenant.addressId,
      tariffVersionId: tenant.catalog.tariffVersionId,
      termsVersion: tenant.catalog.termsVersion,
      publicNumber: `RET-IDEM-${uniquePhone().slice(-6)}`,
      lifecycleState: "inspection",
      assignedPartnerId: partnerId,
    });
    const partner = await assignedPartner();
    const key = `return-idem-${uniquePhone()}`;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${order.id}/return-unprocessed`,
      headers: { cookie: partner.cookie, "idempotency-key": key },
      payload: { reason: "Вещь не подлежит стирке" },
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${order.id}/return-unprocessed`,
      headers: { cookie: partner.cookie, "idempotency-key": key },
      payload: { reason: "Вещь не подлежит стирке" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ orderId: order.id, state: "ready", replayed: true });
    const rows = await db.select().from(orders).where(and(eq(orders.id, order.id)));
    expect(rows.length).toBe(1);
  });

  it("publishes the route in the OpenAPI document", async () => {
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.paths["/partner/orders/:id/return-unprocessed"]?.post).toBeDefined();
  });
});
