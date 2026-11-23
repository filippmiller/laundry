import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { outboxEvents } from "../../src/db/schema.js";
import { chronometry, percentile, summarizeDurations } from "../../src/services/chronometry.js";
import { seedWindow } from "../fixtures.js";
import { makePrincipal } from "../fixtures.js";

describe("The chronometry of an order", () => {
  it("takes the median and the tail of a series of durations", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 5);
    expect(percentile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 5);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("summarises a stage without inventing a number for an empty stage", () => {
    const empty = summarizeDurations("pickup", "От оформления до забора", []);
    expect(empty.samples).toBe(0);
    expect(empty.p50Hours).toBe(0);
    expect(empty.p90Hours).toBe(0);
    const filled = summarizeDurations("pickup", "От оформления до забора", [2, 4]);
    expect(filled.samples).toBe(2);
    expect(filled.p50Hours).toBeCloseTo(3, 5);
    expect(filled.p90Hours).toBeCloseTo(3.8, 5);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("The order cycle time", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => { await close(); });

  /** A tenant of its own, so the counts of one test never leak into the next. */
  async function freshTenant() {
    const seed = await seedWindow(db, { capacity: 2 });
    return {
      organizationId: seed.organizationId,
      principal: makePrincipal(seed.organizationId, seed.userId, ["dispatcher"]),
    };
  }

  /** Writes the milestones of one order with the given gaps, in hours. */
  async function writeOrderTimeline(organizationId: string, orderId: string, gaps: {
    pickup: number; toPartner: number; workshop: number; processing: number; delivery: number;
  }) {
    const start = new Date("2026-11-01T09:00:00.000Z");
    const at = (hours: number) => new Date(start.getTime() + hours * 3_600_000);
    let cursor = 0;
    const rows = [
      { eventType: "order.confirmed", at: cursor },
      { eventType: "order.accept_handoff", at: (cursor += gaps.pickup) },
      { eventType: "order.partner_receive", at: (cursor += gaps.toPartner) },
      { eventType: "order.start_processing", at: (cursor += gaps.workshop) },
      { eventType: "order.qc_passed", at: (cursor += gaps.processing) },
      { eventType: "delivery.delivered", at: (cursor += gaps.delivery) },
    ];
    for (const row of rows) {
      await db.insert(outboxEvents).values({
        organizationId,
        aggregateType: "order",
        aggregateId: orderId,
        eventType: row.eventType,
        payloadJson: {},
        createdAt: at(row.at),
      });
    }
  }

  it("measures every stage of the cycle from the real event log", async () => {
    const tenant = await freshTenant();
    await writeOrderTimeline(tenant.organizationId, randomUUID(), {
      pickup: 2, toPartner: 3, workshop: 4, processing: 5, delivery: 6,
    });
    const report = await chronometry(db, tenant.principal, { days: 3650 });
    const pickup = report.stages.find(stage => stage.key === "pickup");
    expect(pickup?.samples).toBe(1);
    expect(pickup?.p50Hours).toBeCloseTo(2, 5);
    expect(pickup?.p90Hours).toBeCloseTo(2, 5);
    const cycle = report.cycle;
    expect(cycle.samples).toBe(1);
    expect(cycle.p50Hours).toBeCloseTo(20, 5);
  });

  it("tells the tail from the median, so a slow week cannot hide in the average", async () => {
    const tenant = await freshTenant();
    await writeOrderTimeline(tenant.organizationId, randomUUID(), {
      pickup: 1, toPartner: 1, workshop: 1, processing: 1, delivery: 1,
    });
    await writeOrderTimeline(tenant.organizationId, randomUUID(), {
      pickup: 10, toPartner: 1, workshop: 1, processing: 1, delivery: 1,
    });
    const report = await chronometry(db, tenant.principal, { days: 3650 });
    const pickup = report.stages.find(stage => stage.key === "pickup");
    expect(pickup?.samples).toBe(2);
    expect(pickup?.p50Hours).toBeCloseTo(5.5, 5);
    expect(pickup?.p90Hours).toBeGreaterThan(pickup!.p50Hours);
  });

  it("says nothing about a tenant without a single finished order", async () => {
    const empty = await seedWindow(db, { capacity: 1 });
    const principal = makePrincipal(empty.organizationId, empty.userId, ["dispatcher"]);
    const report = await chronometry(db, principal, { days: 30 });
    expect(report.cycle.samples).toBe(0);
    expect(report.stages.every(stage => stage.samples === 0)).toBe(true);
    expect(report.note.length).toBeGreaterThan(0);
  });
});
