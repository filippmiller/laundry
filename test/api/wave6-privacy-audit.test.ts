import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditEvents, deliveryAttempts, users } from "../../src/db/schema.js";
import { makePrincipal } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { churnSignal, maskPhone } from "../../src/services/churn.js";
import { searchOrders } from "../../src/services/workspace.js";

const CHURN_PHONE = "+79997771003";
let phoneCounter = 0;
/** A phone that is unique across the whole test database (users.phone is unique). */
function uniquePhone(): string {
  phoneCounter += 1;
  return `+7999${String(phoneCounter).padStart(6, "0")}`;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 6: privacy — masked churn phone and audited reads (LA-13)", () => {
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

  /** An order whose deliveries failed twice: the churn signal counts exactly that. */
  async function seedChurnOrder(phone: string) {
    const order = await seedFullOrder(db, { state: "scheduled" });
    await db.update(users).set({ phone }).where(eq(users.id, order.userId));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.insert(deliveryAttempts).values({
        organizationId: order.organizationId,
        stopId: order.stopId,
        orderId: order.orderId,
        outcome: "recipient_unavailable",
        reason: "Получателя нет на месте",
        actorId: order.courierId,
        occurredAt: new Date(Date.now() - attempt * 3_600_000),
      });
    }
    return order;
  }

  it("LA-13: the churn signal masks the phone for a role without need-to-know", async () => {
    const order = await seedChurnOrder(CHURN_PHONE);
    const finance = makePrincipal(order.organizationId, order.dispatcher.userId, ["platform_finance"]);

    const signal = await churnSignal(db, finance, { days: 90, threshold: 2 });
    expect(signal.atRisk).toHaveLength(1);
    const risk = signal.atRisk[0];
    expect(risk.customerId).toBe(order.userId);
    expect(risk.phoneMasked).toBe(true);
    expect(signal.phoneMasked).toBe(true);
    expect(risk.phone).toBe("+7999•••1003");
    expect(risk.phone).not.toBe(CHURN_PHONE);
    // The masked number keeps the prefix and the last four digits only.
    expect(risk.phone).toBe(maskPhone(CHURN_PHONE));
  });

  it("LA-13: the masked number of the contract is the number of the contract", () => {
    expect(maskPhone("+79990000103")).toBe("+7999•••0103");
  });

  it("LA-13: the role that has to call the customer sees the number itself", async () => {
    const phone = uniquePhone();
    const order = await seedChurnOrder(phone);
    const dispatcher = makePrincipal(order.organizationId, order.dispatcher.userId, ["dispatcher"]);
    const signal = await churnSignal(db, dispatcher, { days: 90, threshold: 2 });
    expect(signal.atRisk).toHaveLength(1);
    expect(signal.atRisk[0].phoneMasked).toBe(false);
    expect(signal.atRisk[0].phone).toBe(phone);
  });

  it("LA-13: every read of the churn signal is written to the audit log", async () => {
    const phone = uniquePhone();
    const order = await seedChurnOrder(phone);
    const finance = makePrincipal(order.organizationId, order.dispatcher.userId, ["platform_finance"]);
    const before = await db.select().from(auditEvents).where(and(
      eq(auditEvents.organizationId, order.organizationId),
      eq(auditEvents.action, "privacy.churn_read"),
    ));
    expect(before).toHaveLength(0);

    const signal = await churnSignal(db, finance, { days: 90, threshold: 2 });
    const after = await db.select().from(auditEvents).where(and(
      eq(auditEvents.organizationId, order.organizationId),
      eq(auditEvents.action, "privacy.churn_read"),
    ));
    expect(after).toHaveLength(1);
    const scope = after[0].scopeJson as { customerIds?: string[]; count?: number; phoneMasked?: boolean };
    expect(scope.customerIds).toEqual(signal.atRisk.map(risk => risk.customerId));
    expect(scope.count).toBe(1);
    expect(scope.phoneMasked).toBe(true);
    expect(after[0].actorId).toBe(finance.userId);
    // The audit log never carries the phone number itself.
    expect(JSON.stringify(after[0].scopeJson)).not.toContain(phone);
  });

  it("LA-13: the support order search is audited and never writes the phone in full", async () => {
    const phone = uniquePhone();
    const order = await seedChurnOrder(phone);
    const support = makePrincipal(order.organizationId, order.dispatcher.userId, ["customer_support"]);

    const found = await searchOrders(db, support, phone);
    expect(found.length).toBeGreaterThan(0);

    const events = await db.select().from(auditEvents).where(and(
      eq(auditEvents.organizationId, order.organizationId),
      eq(auditEvents.action, "privacy.order_search"),
    ));
    expect(events).toHaveLength(1);
    const scope = events[0].scopeJson as { query?: string; resultCount?: number };
    expect(scope.query).toBe(maskPhone(phone));
    expect(scope.resultCount).toBe(found.length);
    expect(JSON.stringify(events[0].scopeJson)).not.toContain(phone);
  });
});
