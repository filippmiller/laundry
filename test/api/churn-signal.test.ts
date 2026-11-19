import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { deliveryAttempts } from "../../src/db/schema.js";
import { churnSignal } from "../../src/services/churn.js";
import { seedFullOrder } from "../operations-fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("The churn signal", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => { await close(); });

  async function failedAttempt(orderId: string, stopId: string, organizationId: string, outcome: string, actorId: string) {
    await db.insert(deliveryAttempts).values({
      organizationId,
      stopId,
      orderId,
      outcome: outcome as "recipient_unavailable",
      recipientProofJson: {},
      deliveredGarmentIds: [],
      actorId,
      occurredAt: new Date(),
    });
  }

  it("lists the customer whose deliveries keep failing", async () => {
    const f = await seedFullOrder(db);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "recipient_unavailable", f.courierId);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "recipient_unavailable", f.courierId);
    const report = await churnSignal(db, f.dispatcher, { days: 90, threshold: 2 });
    const risky = report.atRisk.find(row => row.customerId === f.principal.userId);
    expect(risky?.failedAttempts).toBe(2);
    expect(risky?.lastOutcome).toBe("recipient_unavailable");
    expect(risky?.phone).toBeTruthy();
  });

  it("keeps a single failure out of the list: one miss is not a churn signal", async () => {
    const f = await seedFullOrder(db);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "recipient_unavailable", f.courierId);
    const report = await churnSignal(db, f.dispatcher, { days: 90, threshold: 2 });
    expect(report.atRisk.find(row => row.customerId === f.principal.userId)).toBeUndefined();
  });

  it("counts a refused delivery as a failed attempt too", async () => {
    const f = await seedFullOrder(db);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "refused", f.courierId);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "refused", f.courierId);
    const report = await churnSignal(db, f.dispatcher, { days: 90, threshold: 2 });
    const risky = report.atRisk.find(row => row.customerId === f.principal.userId);
    expect(risky?.failedAttempts).toBe(2);
  });

  it("does not count a successful delivery as a failure", async () => {
    const f = await seedFullOrder(db);
    await failedAttempt(f.orderId, f.stopId, f.organizationId, "delivered", f.courierId);
    const report = await churnSignal(db, f.dispatcher, { days: 90, threshold: 1 });
    expect(report.atRisk.find(row => row.customerId === f.principal.userId)).toBeUndefined();
  });
});
