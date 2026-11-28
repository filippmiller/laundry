import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { customerAddresses, garments, quotes, users } from "../../src/db/schema.js";
import { seedCatalog, seedDeliveryWindow, seedWindow } from "../fixtures.js";
import { seedFullOrder, seedSeal } from "../operations-fixtures.js";
import { login } from "./_fixtures.js";

const rid = () => randomUUID();

type DeclaredItemBody = {
  subtypeId: string;
  quantity: number;
  declaredValueKopeks?: number | null;
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: the declared value of a piece", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let tenant: Awaited<ReturnType<typeof seedWindow>>;
  let deliveryWindowId: string;
  let catalog: Awaited<ReturnType<typeof seedCatalog>>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();

    tenant = await seedWindow(db, { capacity: 4 });
    deliveryWindowId = await seedDeliveryWindow(db, tenant);
    catalog = await seedCatalog(db, tenant.organizationId);
    await db.insert(customerAddresses).values({
      organizationId: tenant.organizationId,
      customerId: tenant.userId,
      buildingId: tenant.buildingId,
      apartment: "42",
    });
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function customerCookie() {
    const session = await login(app, {
      organizationId: tenant.organizationId,
      phone: tenant.phone,
      roles: ["customer"],
    });
    expect(session.status).toBe(200);
    return session.cookie;
  }

  async function createQuoteHttp(cookie: string, declaredItems: DeclaredItemBody[]) {
    return app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie, "idempotency-key": `quote-${rid()}` },
      payload: {
        buildingId: tenant.buildingId,
        pickupWindowId: tenant.windowId,
        deliveryWindowId,
        lines: [{ serviceId: catalog.serviceId, tier: "protected", quantity: 1_000, unit: "gram" }],
        declaredItems,
      },
    });
  }

  it("keeps the declared value in the immutable snapshot and in the quote hash", async () => {
    const cookie = await customerCookie();
    const withValue = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 2, declaredValueKopeks: 300_000 },
    ]);
    expect(withValue.statusCode).toBe(200);
    const body = withValue.json() as {
      id: string;
      quoteHash: string;
      declaredItems: Array<{ subtypeId: string; quantity: number; declaredValueKopeks: number | null }>;
    };
    expect(body.declaredItems).toHaveLength(1);
    expect(body.declaredItems[0]).toMatchObject({
      subtypeId: "tshirt_plain",
      quantity: 2,
      declaredValueKopeks: 300_000,
    });

    const [stored] = await db.select().from(quotes).where(eq(quotes.id, body.id)).limit(1);
    const snapshot = stored.snapshotJson as {
      declaredItems: Array<{ subtypeId: string; declaredValueKopeks: number | null }>;
    };
    expect(snapshot.declaredItems[0].declaredValueKopeks).toBe(300_000);

    // The same declaration without a value is a different quote: the customer accepted
    // the value they stated, so the hash has to say so.
    const withoutValue = await createQuoteHttp(cookie, [{ subtypeId: "tshirt_plain", quantity: 2 }]);
    expect(withoutValue.statusCode).toBe(200);
    const plain = withoutValue.json() as {
      quoteHash: string;
      declaredItems: Array<{ declaredValueKopeks: number | null }>;
    };
    expect(plain.declaredItems[0].declaredValueKopeks).toBeNull();
    expect(body.quoteHash).not.toBe(plain.quoteHash);
  });

  it("refuses an order that carries an outdated quote hash", async () => {
    const cookie = await customerCookie();
    // The customer states a value, gets a quote and then changes the value. The second quote is a
    // different quote, so the hash of the first one must not accept it: the customer has to take
    // the new quote, not the old one.
    const first = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 1, declaredValueKopeks: 300_000 },
    ]);
    expect(first.statusCode).toBe(200);
    const firstQuote = first.json() as { id: string; quoteHash: string };

    const second = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 1, declaredValueKopeks: 500_000 },
    ]);
    expect(second.statusCode).toBe(200);
    const secondQuote = second.json() as { id: string; quoteHash: string };
    expect(secondQuote.quoteHash).not.toBe(firstQuote.quoteHash);

    // The order takes the second quote but the hash of the first one.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: { cookie, "idempotency-key": `order-${rid()}` },
      payload: {
        quoteId: secondQuote.id,
        acceptedQuoteHash: firstQuote.quoteHash,
        termsVersion: catalog.termsVersion,
      },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("CONFLICT_VERSION");
    expect(body.error?.message).toBe("QUOTE_HASH_MISMATCH");

    // The quote itself stays usable with its own hash.
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: { cookie, "idempotency-key": `order-${rid()}` },
      payload: {
        quoteId: secondQuote.id,
        acceptedQuoteHash: secondQuote.quoteHash,
        termsVersion: catalog.termsVersion,
      },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("refuses a negative declared value with a validation error", async () => {
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 1, declaredValueKopeks: -1 },
    ]);
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a fractional declared value with a validation error", async () => {
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 1, declaredValueKopeks: 1500.5 },
    ]);
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("accepts the shape the customer form sends and returns the very same value", async () => {
    // The customer form sends the picked rows plus the value the customer typed, in kopeks.
    const formRows: DeclaredItemBody[] = [
      { subtypeId: "tshirt_plain", quantity: 3, declaredValueKopeks: 120_000 },
      { subtypeId: "underwear_socks", quantity: 2 },
    ];
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, formRows);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      declaredItems: Array<{ subtypeId: string; quantity: number; declaredValueKopeks: number | null }>;
    };
    expect(body.declaredItems).toHaveLength(2);
    const tshirt = body.declaredItems.find(item => item.subtypeId === "tshirt_plain");
    expect(tshirt).toMatchObject({ quantity: 3, declaredValueKopeks: 120_000 });
    // A customer may hand things over without stating a value: the field stays empty.
    const socks = body.declaredItems.find(item => item.subtypeId === "underwear_socks");
    expect(socks).toMatchObject({ quantity: 2, declaredValueKopeks: null });
  });

  it("reads the declared value back from the quote and from the order the courier reconciles", async () => {
    const cookie = await customerCookie();
    const created = await createQuoteHttp(cookie, [
      { subtypeId: "dress_sundress", quantity: 1, declaredValueKopeks: 450_000 },
    ]);
    expect(created.statusCode).toBe(200);
    const quote = created.json() as { id: string; quoteHash: string };

    const quoteView = await app.inject({
      method: "GET",
      url: `/api/v1/quotes/${quote.id}`,
      headers: { cookie },
    });
    expect(quoteView.statusCode).toBe(200);
    const quoteBody = quoteView.json() as {
      declaredItems: Array<{ subtypeId: string; declaredValueKopeks: number | null }>;
    };
    expect(quoteBody.declaredItems[0].declaredValueKopeks).toBe(450_000);

    const orderResponse = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: { cookie, "idempotency-key": `order-${rid()}` },
      payload: { quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: catalog.termsVersion },
    });
    expect(orderResponse.statusCode).toBe(200);
    const order = orderResponse.json() as { id: string };

    const orderView = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${order.id}`,
      headers: { cookie },
    });
    expect(orderView.statusCode).toBe(200);
    const orderBody = orderView.json() as {
      declaredItems: Array<{ subtypeId: string; declaredValueKopeks: number | null }>;
    };
    expect(orderBody.declaredItems[0].declaredValueKopeks).toBe(450_000);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: the courier settles the declared value at intake", () => {
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

  it("records a discrepancy instead of overwriting the value the customer declared", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    // The fixture quotes without a declaration; the customer's declaration is what the
    // courier reconciles against, so the immutable snapshot of that quote carries one.
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, f.quoteId)).limit(1);
    const snapshot = quote.snapshotJson as Record<string, unknown>;
    await db.update(quotes).set({
      snapshotJson: {
        ...snapshot,
        declaredItems: [{
          subtypeId: "tshirt_plain",
          category: "футболка",
          label: "Футболка",
          quantity: 1,
          declaredValueKopeks: 300_000,
        }],
      },
    }).where(eq(quotes.id, f.quoteId));

    const [courierUser] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, f.courierId));
    const courier = await login(app, {
      organizationId: f.organizationId,
      phone: courierUser.phone!,
      roles: ["courier"],
    });
    expect(courier.status).toBe(200);

    // The courier sees what the customer declared — that is the reference of the intake.
    const orderView = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${f.orderId}`,
      headers: { cookie: courier.cookie },
    });
    expect(orderView.statusCode).toBe(200);
    const view = orderView.json() as {
      declaredItems: Array<{ subtypeId: string; declaredValueKopeks: number | null }>;
    };
    expect(view.declaredItems[0].declaredValueKopeks).toBe(300_000);

    const seal = await seedSeal(db, f.organizationId);
    const intake = await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${f.stopId}/intake`,
      headers: { cookie: courier.cookie, "idempotency-key": `intake-${rid()}` },
      payload: {
        mode: "protected_items",
        bags: [{
          containerCode: `BAG-${rid().slice(0, 8)}`,
          sealSerial: seal.serial,
          weightGrams: 1_200,
        }],
        items: [{
          itemCode: `IT-${rid().slice(0, 6)}`,
          category: "футболка",
          description: "Футболка",
          subtypeId: "tshirt_plain",
          // The courier records a different value and says so: a discrepancy, not a
          // silent overwrite of what the customer declared.
          declaredValueKopeks: 250_000,
          declaredValueSettlement: "discrepancy",
        }],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    });
    expect(intake.statusCode, intake.body).toBe(200);

    const [garment] = await db.select().from(garments).where(eq(garments.orderId, f.orderId)).limit(1);
    expect(garment.declaredValueKopeks).toBe(250_000);
    const condition = garment.conditionJson as { declaredValueSettlement?: string };
    expect(condition.declaredValueSettlement).toBe("discrepancy");
  });
});
