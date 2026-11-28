import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { outboxEvents, serviceWindows, slotReservations } from "../../src/db/schema.js";
import { seedWindow } from "../fixtures.js";
import { login, seedPartner, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

/**
 * The routes the parent wired by hand for the triple audit of 2026-11-25:
 * the preview configuration, the manual operations that replace the background worker, and the
 * partner-scoped views of the money loop.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 6 ops and preview routes (audit 2026-11-25)", () => {
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

  it("GET /preview/config states whether a preview key is enforced", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/preview/config" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { previewEnabled: boolean; requiresPreviewKey: boolean };
    expect(typeof body.previewEnabled).toBe("boolean");
    expect(typeof body.requiresPreviewKey).toBe("boolean");
    // A key is only required when the deployment actually configures one.
    expect(body.requiresPreviewKey).toBe(Boolean(process.env.PREVIEW_ACCESS_KEY));
  });

  it("POST /ops/expire-holds is closed to a customer and open to an admin", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const admin = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["platform_admin"],
    });
    expect(admin.status).toBe(200);

    const customer = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["customer"],
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/ops/expire-holds",
      headers: { cookie: customer.cookie },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/ops/expire-holds",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as { expired: number };
    expect(typeof body.expired).toBe("number");
  });

  it("POST /ops/outbox/drain is closed to a customer and open to an admin", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const admin = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["platform_admin"],
    });
    const customer = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["customer"],
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/ops/outbox/drain",
      headers: { cookie: customer.cookie },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/ops/outbox/drain",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as { processed: number; failed: number };
    expect(typeof body.processed).toBe("number");
    expect(typeof body.failed).toBe("number");
  });

  it("an expired hold stops holding capacity after the sweep", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const admin = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["platform_admin"],
    });

    await db.update(serviceWindows).set({ reservedOrders: 1 }).where(eq(serviceWindows.id, seed.windowId));

    const [reservation] = await db.insert(slotReservations).values({
      organizationId: seed.organizationId,
      windowId: seed.windowId,
      principalId: seed.userId,
      state: "held",
      expiresAt: new Date(Date.now() - 60_000),
      capacityUnits: 1,
      idempotencyKey: `test-${rid()}`,
      requestHash: "d".repeat(64),
    }).returning();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ops/expire-holds",
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    const [after] = await db.select().from(slotReservations).where(eq(slotReservations.id, reservation.id)).limit(1);
    expect(after.state).not.toBe("held");

    const [windowAfter] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId)).limit(1);
    expect(windowAfter.reservedOrders).toBe(0);
  });

  it("the partner-scoped money routes answer the partner and hide a customer", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const partnerId = await seedPartner(db, seed.organizationId, `Прачечка ${Math.random().toString(36).slice(2)}`);
    const partner = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["partner_finance"],
      partnerId,
    });
    expect(partner.status).toBe(200);

    for (const path of ["/api/v1/partner/disputes", "/api/v1/partner/payouts", "/api/v1/partner/credit-notes"]) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie: partner.cookie },
      });
      expect(response.statusCode, `${path} must answer the partner`).toBe(200);
      const body = response.json() as unknown;
      expect(body === null || typeof body === "object").toBe(true);
    }

    // A partner without a partner scope gets no money view at all.
    const scopeless = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["partner_finance"],
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/partner/payouts",
      headers: { cookie: scopeless.cookie },
    });
    expect(denied.statusCode).toBe(403);

    const customer = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["customer"],
    });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/partner/payouts",
      headers: { cookie: customer.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("the finance dispute list is closed to a customer and open to finance", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const customer = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["customer"],
    });
    const finance = await login(app, {
      organizationId: seed.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/finance/partner-disputes",
      headers: { cookie: customer.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/finance/partner-disputes",
      headers: { cookie: finance.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as { items?: unknown[]; nextCursor?: string | null };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("the outbox drain does not touch another tenant's events", async () => {
    const seedA = await seedWindow(db, { capacity: 2 });
    const seedB = await seedWindow(db, { capacity: 2 });
    const adminB = await login(app, {
      organizationId: seedB.organizationId,
      phone: uniquePhone(),
      roles: ["platform_admin"],
    });

    await db.insert(outboxEvents).values({
      organizationId: seedA.organizationId,
      aggregateType: "test",
      aggregateId: randomUUID(),
      eventType: "test.pending",
      payloadJson: {},
      state: "pending",
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/ops/outbox/drain",
      headers: { cookie: adminB.cookie },
      payload: {},
    });

    const [event] = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.organizationId, seedA.organizationId), eq(outboxEvents.eventType, "test.pending")))
      .limit(1);
    expect(event.state).toBe("pending");
  });
});
