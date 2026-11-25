import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import {
  partnerCreditNotes, partnerDisputes, partnerInvoiceLines, partnerInvoices, partnerPayouts,
} from "../../src/db/schema.js";
import { seedDemo } from "../../src/services/seed.js";

/**
 * The demo stand is re-seeded on every visit, and the seed answers 200 every time.
 *
 * The seed used to fail with 409 when PostgreSQL handed out the partner invoice lines in a
 * different order than the run before: the book names the two lines in its idempotency keys,
 * so a re-run settled the other dispute under the key of the first one and the request hash
 * no longer matched. The stand then answered "conflict" to a visitor who only wanted to look
 * at the demo.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 6: the demo seed stays idempotent (audit 2026-11-25)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  /** The money slice of the demo tenant, with the dispute of every line named. */
  async function moneyOf(organizationId: string) {
    const [invoices, disputes, notes, payouts] = await Promise.all([
      db.select().from(partnerInvoices).where(eq(partnerInvoices.organizationId, organizationId)),
      db.select().from(partnerDisputes).where(eq(partnerDisputes.organizationId, organizationId)),
      db.select().from(partnerCreditNotes).where(eq(partnerCreditNotes.organizationId, organizationId)),
      db.select().from(partnerPayouts).where(eq(partnerPayouts.organizationId, organizationId)),
    ]);
    return {
      invoices: invoices.length,
      disputes: disputes.length,
      notes: notes.length,
      payouts: payouts.length,
      disputeLines: disputes.map(row => `${row.id}:${row.invoiceLineId}:${row.state}`).sort(),
    };
  }

  it("LA-14: repeated seeds leave the partner money slice exactly as it was", async () => {
    const summary = await seedDemo(db);
    const organizationId = summary.organizationId;
    const first = await moneyOf(organizationId);
    expect(first.invoices).toBeGreaterThan(0);
    expect(first.disputes).toBeGreaterThan(1);
    expect(first.payouts).toBeGreaterThan(0);

    await seedDemo(db);
    await seedDemo(db);

    const last = await moneyOf(organizationId);
    expect(last).toEqual(first);
  });

  it("LA-14: the open dispute stays on the first line when the lines are handed out in another order", async () => {
    const summary = await seedDemo(db);
    const organizationId = summary.organizationId;
    const [invoice] = await db.select().from(partnerInvoices)
      .where(eq(partnerInvoices.organizationId, organizationId)).limit(1);
    expect(invoice).toBeDefined();
    const linesById = await db.select().from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.invoiceId, invoice!.id)).orderBy(asc(partnerInvoiceLines.id));
    expect(linesById.length).toBeGreaterThanOrEqual(2);

    // The lines are rewritten in the opposite order. PostgreSQL then hands them out in that
    // order to a SELECT without ORDER BY — which is exactly what used to swap the roles of
    // the open and the settled dispute between two runs of the seed.
    for (const line of [...linesById].reverse()) {
      await db.update(partnerInvoiceLines)
        .set({ state: line.state })
        .where(eq(partnerInvoiceLines.id, line.id));
    }
    const scanOrder = await db.select().from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.invoiceId, invoice!.id));
    expect(scanOrder).toHaveLength(linesById.length);

    const before = await moneyOf(organizationId);
    await seedDemo(db);
    const after = await moneyOf(organizationId);
    expect(after).toEqual(before);

    // The first line by id still carries the one dispute that stays open, whichever order the
    // scan used.
    const open = await db.select().from(partnerDisputes).where(and(
      eq(partnerDisputes.organizationId, organizationId),
      eq(partnerDisputes.invoiceLineId, linesById[0].id),
    ));
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe("open");
  });
});
