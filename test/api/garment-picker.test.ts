import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { customerAddresses, garments, priceRules, quotes } from "../../src/db/schema.js";
import { recordIntake } from "../../src/services/intake.js";
import { createQuote } from "../../src/services/quotes.js";
import {
  GARMENT_CATEGORIES, GARMENT_SUBTYPES, MAX_PICKED_QUANTITY, findSubtype, normalizeCategory, normalizeDeclaredItems,
} from "../../shared/garment-taxonomy.js";
import { seedFullOrder, seedSeal } from "../operations-fixtures.js";
import { seedCatalog, seedDeliveryWindow, seedWindow } from "../fixtures.js";
import { login } from "./_fixtures.js";

const rid = () => randomUUID();

describe("The handover taxonomy", () => {
  it("gives every subtype a unique id and every category at least one subtype", () => {
    const ids = GARMENT_SUBTYPES.map(subtype => subtype.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of GARMENT_CATEGORIES) {
      expect(category.subtypes.length).toBeGreaterThan(0);
      for (const subtype of category.subtypes) {
        expect(subtype.label.trim().length).toBeGreaterThan(0);
        expect(subtype.category.trim().length).toBeGreaterThan(0);
        expect(findSubtype(subtype.id)).toBe(subtype);
      }
    }
  });

  it("covers the families the handover screen promises: tops, shirts, dresses, coats, underwear, linen", () => {
    const labels = GARMENT_SUBTYPES.map(subtype => subtype.label.toLowerCase()).join(" ");
    for (const expected of ["футболка", "рубашка", "платье", "пальто", "куртка", "трусы", "бюстгальтер", "носки", "халат", "полотенце", "простыня"]) {
      expect(labels).toContain(expected);
    }
  });

  it("merges duplicated subtypes and caps the quantity of one row", () => {
    const result = normalizeDeclaredItems([
      { subtypeId: "tshirt_plain", quantity: 2 },
      { subtypeId: "tshirt_plain", quantity: 3 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].quantity).toBe(5);
    expect(result.items[0].category).toBe("футболка");
  });

  it("rejects an unknown subtype and an out-of-range quantity", () => {
    const unknown = normalizeDeclaredItems([{ subtypeId: "пиджак", quantity: 1 }]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toBe("UNKNOWN_GARMENT_SUBTYPE");

    const tooMany = normalizeDeclaredItems([{ subtypeId: "tshirt_plain", quantity: MAX_PICKED_QUANTITY + 1 }]);
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.error).toBe("INVALID_GARMENT_QUANTITY");

    const zero = normalizeDeclaredItems([{ subtypeId: "tshirt_plain", quantity: 0 }]);
    expect(zero.ok).toBe(false);
  });

  it("folds the categories a partner typed by hand into the same vocabulary", () => {
    expect(normalizeCategory("Футболки")).toBe("футболка");
    expect(normalizeCategory(" tee ")).toBe("футболка");
    expect(normalizeCategory("Пальто")).toBe("куртка");
    expect(normalizeCategory("что-то неопознанное")).toBe("прочее");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("The handover declaration", () => {
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
    // The catalogue fixture only prices the economy tier; the protected tier is the one
    // that promises a per-item manifest, so it needs a rule of its own.
    await db.insert(priceRules).values({
      tariffVersionId: catalog.tariffVersionId,
      serviceId: catalog.serviceId,
      tier: "protected",
      unitPriceKopeks: 15,
      minQuantity: 1,
      roundingRule: "gram_up_to_100",
    }).onConflictDoNothing();
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

  async function createQuoteHttp(cookie: string, declaredItems: unknown[]) {
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

  it("keeps the customer's declaration inside the immutable quote", async () => {
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, [
      { subtypeId: "tshirt_plain", quantity: 3 },
      { subtypeId: "underwear_socks", quantity: 2 },
    ]);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      id: string; quoteHash: string; declaredItems: Array<{ subtypeId: string; category: string; label: string; quantity: number }>;
    };
    expect(body.declaredItems).toHaveLength(2);
    expect(body.declaredItems[0]).toMatchObject({ subtypeId: "tshirt_plain", category: "футболка", quantity: 3 });
    expect(body.declaredItems[1]).toMatchObject({ subtypeId: "underwear_socks", category: "бельё", quantity: 2 });

    const [stored] = await db.select().from(quotes).where(eq(quotes.id, body.id)).limit(1);
    const snapshot = stored.snapshotJson as { declaredItems?: Array<{ subtypeId: string; quantity: number }> };
    expect(snapshot.declaredItems).toHaveLength(2);
  });

  it("changes the quote hash when the declaration changes, so the customer accepted that list", async () => {
    const cookie = await customerCookie();
    const first = await createQuoteHttp(cookie, [{ subtypeId: "tshirt_plain", quantity: 3 }]);
    const second = await createQuoteHttp(cookie, [{ subtypeId: "tshirt_plain", quantity: 4 }]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json() as { quoteHash: string };
    const b = second.json() as { quoteHash: string };
    expect(a.quoteHash).not.toBe(b.quoteHash);
  });

  it("refuses a subtype that is not in the taxonomy", async () => {
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, [{ subtypeId: "какой-то вид вещи", quantity: 1 }]);
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.message).toBe("UNKNOWN_GARMENT_SUBTYPE");
  });

  it("refuses a quantity the slider could never produce", async () => {
    const cookie = await customerCookie();
    const response = await createQuoteHttp(cookie, [{ subtypeId: "tshirt_plain", quantity: 999 }]);
    expect(response.statusCode).toBe(400);
  });

  it("refuses a per-item list on an economy quote, because that tariff promises none", async () => {
    const cookie = await customerCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie, "idempotency-key": `quote-${rid()}` },
      payload: {
        buildingId: tenant.buildingId,
        pickupWindowId: tenant.windowId,
        deliveryWindowId,
        lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
        declaredItems: [{ subtypeId: "tshirt_plain", quantity: 3 }],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: { message?: string } };
    expect(body.error?.message).toBe("DECLARATION_REQUIRES_PROTECTED_TIER");
  });

  it("shows the courier the declaration the customer accepted", async () => {
    const cookie = await customerCookie();
    const quoteResponse = await createQuoteHttp(cookie, [
      { subtypeId: "dress_sundress", quantity: 1 },
      { subtypeId: "coat_overcoat", quantity: 1 },
    ]);
    expect(quoteResponse.statusCode).toBe(200);
    const quote = quoteResponse.json() as { id: string; quoteHash: string };

    const orderResponse = await app.inject({
      method: "POST",
      url: "/api/v1/orders",
      headers: { cookie, "idempotency-key": `order-${rid()}` },
      payload: { quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: catalog.termsVersion },
    });
    expect(orderResponse.statusCode).toBe(200);
    const order = orderResponse.json() as { id: string };

    const viewResponse = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${order.id}`,
      headers: { cookie },
    });
    expect(viewResponse.statusCode).toBe(200);
    const view = viewResponse.json() as {
      declaredItems?: Array<{ subtypeId: string; label: string; quantity: number }>;
    };
    expect(view.declaredItems).toHaveLength(2);
    expect(view.declaredItems?.map(item => item.subtypeId).sort()).toEqual(["coat_overcoat", "dress_sundress"]);
  });

  it("rejects an unknown subtype in the service layer too", async () => {
    const principal = {
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      roles: ["customer" as const],
      requestId: rid(),
    };
    await expect(createQuote(db, principal, {
      buildingId: tenant.buildingId,
      pickupWindowId: tenant.windowId,
      deliveryWindowId,
      tariffVersionId: catalog.tariffVersionId,
      key: `quote-${rid()}`,
      lines: [{ serviceId: catalog.serviceId, tier: "protected", quantity: 1_000, unit: "gram" }],
      declaredItems: [{ subtypeId: "несуществующий", quantity: 1 }],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("Courier acceptance", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  it("takes the category from the taxonomy, not from the request", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const seal = await seedSeal(db, f.organizationId);
    const containerCode = `BAG-${rid().slice(0, 8)}`;
    await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode, sealSerial: seal.serial, weightGrams: 1_200 }],
      items: [{
        itemCode: `PICK-${rid().slice(0, 8)}`,
        category: "что-то неопознанное",
        description: "Бюстгальтер",
        subtypeId: "underwear_bra",
        declaredValueKopeks: 250_000,
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });

    const [garment] = await db.select().from(garments).where(eq(garments.orderId, f.orderId)).limit(1);
    expect(garment.category).toBe("бельё");
    const condition = garment.conditionJson as { subtypeId?: string; subtypeLabel?: string };
    expect(condition.subtypeId).toBe("underwear_bra");
    expect(condition.subtypeLabel).toBe("Бюстгальтер");
  });

  it("refuses an acceptance that names a subtype the taxonomy does not know", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const seal = await seedSeal(db, f.organizationId);
    await expect(recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-${rid().slice(0, 8)}`, sealSerial: seal.serial, weightGrams: 1_200 }],
      items: [{
        itemCode: `PICK-${rid().slice(0, 8)}`,
        category: "футболка",
        description: "Футболка",
        subtypeId: "несуществующий",
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
