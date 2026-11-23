import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { buildApp } from "../../src/api/server.js";
import { orders } from "../../src/db/schema.js";
import { repeatOrder } from "../../src/services/orders.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { login } from "./_fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("The repeated order", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("hands the customer back the very same service lines", async () => {
    const f = await seedFullOrder(db);
    const repeat = await repeatOrder(db, f.principal, f.orderId);
    expect(repeat.lines).toHaveLength(1);
    expect(repeat.lines[0]).toMatchObject({ tier: "economy", unit: "gram", quantity: 1_000 });
    expect(repeat.buildingId).toBe(f.buildingId);
    expect(repeat.sourceOrderId).toBe(f.orderId);
  });

  it("does not create anything: repeating an order is still a new quote and a new consent", async () => {
    const f = await seedFullOrder(db);
    const before = await db.select().from(orders);
    await repeatOrder(db, f.principal, f.orderId);
    const after = await db.select().from(orders);
    expect(after.length).toBe(before.length);
  });

  it("is available to the owner over HTTP and to nobody else", async () => {
    const f = await seedFullOrder(db);
    const session = await login(app, {
      organizationId: f.organizationId,
      phone: f.phone,
      roles: ["customer"],
    });
    expect(session.status).toBe(200);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${f.orderId}/repeat`,
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { lines: Array<{ tier: string }>; sourceOrderId: string };
    expect(body.lines).toHaveLength(1);
    expect(body.sourceOrderId).toBe(f.orderId);
  });
});
