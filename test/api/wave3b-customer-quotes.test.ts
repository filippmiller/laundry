import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { buildings, customerAddresses, orders } from "../../src/db/schema.js";
import { createOrder } from "../../src/services/orders.js";
import { createQuote, getQuote } from "../../src/services/quotes.js";
import { makePrincipal, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3B: customer quotes addressId & termsVersion", () => {
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

  async function seedMultiApartmentFixture(termsVersion = "offer-2026-wave3b") {
    const seed = await seedWindow(db, { capacity: 4 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId, termsVersion);

    const [apt42] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: seed.userId,
      buildingId: seed.buildingId,
      apartment: "42",
    }).returning();
    const [apt99] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: seed.userId,
      buildingId: seed.buildingId,
      apartment: "99",
    }).returning();

    const otherUserId = await seedUser(db, seed.organizationId);
    const [otherAddress] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: otherUserId,
      buildingId: seed.buildingId,
      apartment: "101",
    }).returning();

    const [otherBuilding] = await db.insert(buildings).values({
      organizationId: seed.organizationId,
      cityId: seed.cityId,
      address: `ул. Другая, ${rid().slice(0, 6)}`,
    }).returning();
    const [otherBuildingAddress] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: seed.userId,
      buildingId: otherBuilding.id,
      apartment: "7",
    }).returning();

    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    return {
      ...seed,
      deliveryWindowId,
      catalog,
      principal,
      apt42Id: apt42.id,
      apt99Id: apt99.id,
      otherCustomerAddressId: otherAddress.id,
      otherBuildingAddressId: otherBuildingAddress.id,
    };
  }

  it("binds the selected apartment addressId when creating a quote and subsequent order", async () => {
    const f = await seedMultiApartmentFixture("offer-2026-exact-apt");
    const quote = await createQuote(db, f.principal, {
      buildingId: f.buildingId,
      addressId: f.apt99Id,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `q-apt99-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });

    expect(quote.addressId).toBe(f.apt99Id);
    expect(quote.snapshot.addressId).toBe(f.apt99Id);
    expect(quote.termsVersion).toBe("offer-2026-exact-apt");

    const loadedQuote = await getQuote(db, f.principal, quote.id);
    expect(loadedQuote.addressId).toBe(f.apt99Id);
    expect(loadedQuote.termsVersion).toBe("offer-2026-exact-apt");

    const order = await createOrder(db, f.principal, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: quote.termsVersion,
      key: `o-apt99-${rid()}`,
    });
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    expect(orderRow.addressId).toBe(f.apt99Id);
    expect(orderRow.termsVersion).toBe("offer-2026-exact-apt");
  });

  it("keeps fallback address resolution when addressId is omitted", async () => {
    const f = await seedMultiApartmentFixture("offer-2026-fallback");
    const quote = await createQuote(db, f.principal, {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `q-fallback-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });

    expect([f.apt42Id, f.apt99Id]).toContain(quote.addressId);
    expect(quote.termsVersion).toBe("offer-2026-fallback");
  });

  it("rejects another customer's addressId or an addressId in another building with NOT_FOUND", async () => {
    const f = await seedMultiApartmentFixture();
    await expect(createQuote(db, f.principal, {
      buildingId: f.buildingId,
      addressId: f.otherCustomerAddressId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `q-other-cust-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    })).rejects.toThrow("NOT_FOUND");

    await expect(createQuote(db, f.principal, {
      buildingId: f.buildingId,
      addressId: f.otherBuildingAddressId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `q-other-bldg-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    })).rejects.toThrow("NOT_FOUND");
  });
});
