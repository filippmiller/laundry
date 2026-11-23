import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import { seedAddress, seedCatalog, seedWindow } from "./fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("HTTP API contract", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let seed: Awaited<ReturnType<typeof seedWindow>>;
  let catalog: Awaited<ReturnType<typeof seedCatalog>>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
    seed = await seedWindow(db, { capacity: 2 });
    catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  async function login(organizationId: string, phone: string, role: "customer" | "dispatcher" = "customer") {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles: [role] },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0];
    return { cookie };
  }

  it("serves a health check and a generated OpenAPI document", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).json().status).toBe("ok");
    const spec = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json() as {
      openapi: string; paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/orders"]).toBeDefined();
    expect(spec.paths["/quotes"]).toBeDefined();
  });

  it("rejects unauthenticated access and derives the tenant from the session, not the body", async () => {
    const unauth = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(unauth.statusCode).toBe(401);
    const { cookie } = await login(seed.organizationId, seed.phone);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ organizationId: seed.organizationId });
  });

  it("POST /quotes is idempotent and rejects a changed body under the same key", async () => {
    const { cookie } = await login(seed.organizationId, seed.phone);
    const [delivery] = await db.insert((await import("../src/db/schema.js")).serviceWindows).values({
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      kind: "delivery",
      startsAt: new Date("2026-12-02T10:00:00Z"),
      endsAt: new Date("2026-12-02T12:00:00Z"),
      capacityOrders: 5,
    }).returning();
    const payload = {
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId: delivery.id,
      tariffVersionId: catalog.tariffVersionId,
      lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    };
    const first = await app.inject({
      method: "POST", url: "/api/v1/quotes", headers: { cookie, "idempotency-key": "api-quote-1" }, payload,
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST", url: "/api/v1/quotes", headers: { cookie, "idempotency-key": "api-quote-1" }, payload,
    });
    expect(replay.json()).toMatchObject({ id: first.json().id, replayed: true });
    const conflict = await app.inject({
      method: "POST", url: "/api/v1/quotes", headers: { cookie, "idempotency-key": "api-quote-1" },
      payload: { ...payload, lines: [{ ...payload.lines[0], quantity: 2_000 }] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_PAYLOAD_CONFLICT");
  });

  it("returns a safe NOT_FOUND for cross-tenant resources", async () => {
    const owner = await login(seed.organizationId, seed.phone);
    const foreignSeed = await seedWindow(db, { capacity: 1 });
    const foreign = await login(foreignSeed.organizationId, foreignSeed.phone);
    const orderResponse = await app.inject({
      method: "POST", url: "/api/v1/orders", headers: { cookie: owner.cookie, "idempotency-key": "api-order-tenant" },
      payload: { quoteId: "00000000-0000-4000-8000-000000000000", acceptedQuoteHash: "a".repeat(64), termsVersion: catalog.termsVersion },
    });
    expect(orderResponse.statusCode).toBe(404);
    const denied = await app.inject({
      method: "GET", url: `/api/v1/orders/${orderResponse.json().id ?? "00000000-0000-4000-8000-000000000001"}`,
      headers: { cookie: foreign.cookie },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe("NOT_FOUND");
  });
});
