import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { customerAddresses, users } from "../../src/db/schema.js";
import { seedWindow, makePrincipal } from "../fixtures.js";
import { listAddresses } from "../../src/services/customer.js";

/**
 * Customer data isolation on the address book.
 *
 * The previous version of this file was named "AU-001: Verified landing" but only asserted
 * that `listAddresses` returns an Array — it verified nothing. The test below states exactly
 * what it proves: inside one tenant, a customer sees their own address and never another
 * customer's.
 */
describe("Customer address book isolation", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 4 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  it("shows a customer only their own addresses", async () => {
    const seed = await seedWindow(db);
    const [otherCustomer] = await db.insert(users).values({
      phone: `+79${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`,
    }).returning();

    const [mine] = await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: seed.userId,
      buildingId: seed.buildingId,
      apartment: "42",
    }).returning();
    await db.insert(customerAddresses).values({
      organizationId: seed.organizationId,
      customerId: otherCustomer.id,
      buildingId: seed.buildingId,
      apartment: "77",
    });

    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const addresses = await listAddresses(db, principal);

    expect(addresses.length).toBe(1);
    expect(addresses[0].id).toBe(mine.id);
    expect(addresses[0].apartment).toBe("42");
    expect(addresses[0].buildingId).toBe(seed.buildingId);
  });
});
