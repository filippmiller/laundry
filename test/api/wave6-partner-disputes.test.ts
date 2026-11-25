import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  courierShifts, orders, outboxEvents, partnerCreditNotes, partnerDisputes, partnerInvoiceLines, partnerInvoices,
  partnerPayouts, partnerServiceAccruals, routes, routeStops, serviceWindows, slotReservations,
} from "../../src/db/schema.js";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";
import { seedFullOrder, seedPartner, seedSeal } from "../operations-fixtures.js";
import { createQuote } from "../../src/services/quotes.js";
import { createOrder, scheduleOrder } from "../../src/services/orders.js";
import { holdSlot } from "../../src/domain/slot-reservation.js";
import { recordIntake } from "../../src/services/intake.js";
import { assignOrderToPartner, receiveHandoff } from "../../src/services/partner.js";
import { openThread } from "../../src/services/support.js";
import {
  createPartnerInvoice, disputePartnerLine, drainOutbox, expireDueHolds, listPartnerDisputes,
  listPartnerScopedCreditNotes, listPartnerScopedDisputes, listPartnerScopedPayouts, partnerAccruals,
  resolvePartnerDispute,
} from "../../src/services/finance.js";
import { seedDemo } from "../../src/services/seed.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 6: partner disputes, partner-scoped money (LA-05, LA-18)", () => {
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

  /**
   * One order with two service lines, handed over to a laundry partner: the partner accrues
   * twice, so the partner invoice has two lines and can carry two disputes.
   */
  async function seedBilledOrder() {
    const seed = await seedWindow(db, { capacity: 3 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const customer = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const dispatcher = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["dispatcher"]);
    const courierId = await seedUser(db, seed.organizationId);
    const courier = makePrincipal(seed.organizationId, courierId, ["courier"]);

    const quote = await createQuote(db, customer, {
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      tariffVersionId: catalog.tariffVersionId,
      key: `quote-${rid()}`,
      lines: [
        { serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" },
        { serviceId: catalog.serviceId, tier: "protected", quantity: 500, unit: "gram" },
      ],
    });
    const order = await createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: catalog.termsVersion,
      key: `order-${rid()}`,
    });
    const hold = await holdSlot(db, {
      principal: customer, windowId: seed.windowId, key: `hold-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"), expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    const deliveryHold = await holdSlot(db, {
      principal: customer, windowId: deliveryWindowId, key: `dhold-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"), expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    await scheduleOrder(db, customer, {
      orderId: order.id,
      pickupReservationId: hold.reservationId,
      deliveryReservationId: deliveryHold.reservationId,
      key: `sched-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    await db.update(orders).set({ lifecycleState: "pickup_assigned" }).where(eq(orders.id, order.id));
    const [shift] = await db.insert(courierShifts).values({
      organizationId: seed.organizationId,
      courierId,
      state: "active",
      startsAt: new Date("2026-12-01T08:00:00Z"),
      endsAt: new Date("2026-12-02T20:00:00Z"),
    }).returning();
    const [route] = await db.insert(routes).values({
      organizationId: seed.organizationId,
      shiftId: shift.id,
      kind: "pickup",
      plannedStart: new Date("2026-12-01T10:00:00Z"),
      plannedEnd: new Date("2026-12-01T12:00:00Z"),
    }).returning();
    await db.insert(routeStops).values({
      organizationId: seed.organizationId,
      routeId: route.id,
      orderId: order.id,
      buildingId: seed.buildingId,
      kind: "pickup",
      sequence: 1,
      state: "pending",
      assignedCourierId: courierId,
    });
    return { ...seed, deliveryWindowId, catalog, customer, dispatcher, courier, orderId: order.id, shiftId: shift.id };
  }

  /** An order handed over to a partner, with the partner invoice that bills the work. */
  async function seedPartnerInvoice() {
    const order = await seedBilledOrder();
    const partner = await seedPartner(db, order.organizationId);
    await assignOrderToPartner(db, order.dispatcher, {
      orderId: order.orderId, partnerId: partner.partnerId, key: `assign-${rid()}`,
    });
    const seal = await seedSeal(db, order.organizationId);
    const bag = `BAG-${rid().slice(0, 6)}`;
    const intake = await recordIntake(db, order.courier, {
      orderId: order.orderId,
      mode: "mixed",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_500 }],
      items: [{
        itemCode: `IT-${rid().slice(0, 6)}`,
        category: "shirt",
        description: "Рубашка",
        condition: { stains: false, damage: false },
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: order.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_500 }],
      key: `receive-${rid()}`,
    });
    const finance = makePrincipal(order.organizationId, await seedUser(db, order.organizationId), ["platform_finance"]);
    const invoice = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      key: `pinv-${rid()}`,
    });
    const lines = await db.select().from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.invoiceId, invoice.invoiceId));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    return { ...order, partner, finance, invoice, lines };
  }

  it("LA-18/LA-05: an open dispute shows up in the finance list and the resolution produces a credit note", async () => {
    const fixture = await seedPartnerInvoice();
    const [firstLine, secondLine] = fixture.lines;

    const dispute = await disputePartnerLine(db, fixture.finance, {
      lineId: firstLine.id,
      reason: "Вес по описи не совпал с начисленным.",
      key: `dispute-${rid()}`,
    });
    expect(dispute.state).toBe("open");

    const list = await listPartnerDisputes(db, fixture.finance, {});
    const item = list.items.find(entry => entry.id === dispute.disputeId);
    expect(item).toBeDefined();
    expect(item?.invoiceId).toBe(fixture.invoice.invoiceId);
    expect(item?.invoiceLineId).toBe(firstLine.id);
    expect(item?.partnerId).toBe(fixture.partner.partnerId);
    expect(item?.state).toBe("open");
    expect(item?.outcome).toBeNull();
    expect(item?.creditKopeks).toBe(0);
    expect(item?.creditNoteId).toBeNull();
    expect(item?.amountKopeks).toBe(firstLine.amountKopeks);
    expect(item?.resolvedAt).toBeNull();

    // The state filter is honest: an open dispute is not a resolved one.
    expect((await listPartnerDisputes(db, fixture.finance, { state: "open" })).items.map(e => e.id))
      .toContain(dispute.disputeId);
    expect((await listPartnerDisputes(db, fixture.finance, { state: "resolved" })).items.map(e => e.id))
      .not.toContain(dispute.disputeId);

    const resolved = await resolvePartnerDispute(db, fixture.finance, {
      disputeId: dispute.disputeId,
      outcome: "upheld",
      reason: "Расхождение подтверждено приёмкой у прачечной.",
      key: `resolve-${rid()}`,
    });
    expect(resolved.state).toBe("resolved");
    expect(resolved.lineState).toBe("credited");
    expect(resolved.creditNoteId).toBeTruthy();

    const [note] = await db.select().from(partnerCreditNotes)
      .where(eq(partnerCreditNotes.id, resolved.creditNoteId!));
    expect(note).toBeDefined();
    expect(note.amountKopeks).toBe(firstLine.amountKopeks);
    expect(note.disputeId).toBe(dispute.disputeId);

    const after = await listPartnerDisputes(db, fixture.finance, {});
    const settled = after.items.find(entry => entry.id === dispute.disputeId);
    expect(settled?.state).toBe("resolved");
    expect(settled?.outcome).toBe("upheld");
    expect(settled?.creditKopeks).toBe(firstLine.amountKopeks);
    expect(settled?.creditNoteId).toBe(resolved.creditNoteId);
    expect(settled?.resolvedAt).toBeTruthy();

    // The second line of the same invoice can carry its own dispute.
    const second = await disputePartnerLine(db, fixture.finance, {
      lineId: secondLine.id,
      reason: "Часть вещей обработана не по тарифу.",
      key: `dispute2-${rid()}`,
    });
    const both = await listPartnerDisputes(db, fixture.finance, {});
    expect(both.items.map(entry => entry.id)).toEqual(expect.arrayContaining([dispute.disputeId, second.disputeId]));
  });

  it("LA-18: the dispute list pages by keyset cursor without repeating a row", async () => {
    const fixture = await seedPartnerInvoice();
    const [firstLine, secondLine] = fixture.lines;
    await disputePartnerLine(db, fixture.finance, {
      lineId: firstLine.id, reason: "Первый спор.", key: `dispute-a-${rid()}`,
    });
    await disputePartnerLine(db, fixture.finance, {
      lineId: secondLine.id, reason: "Второй спор.", key: `dispute-b-${rid()}`,
    });

    const page1 = await listPartnerDisputes(db, fixture.finance, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listPartnerDisputes(db, fixture.finance, { limit: 1, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
  });

  it("LA-05: the partner sees its own disputes, payouts and credit notes only", async () => {
    const fixture = await seedPartnerInvoice();
    const [firstLine] = fixture.lines;
    const dispute = await disputePartnerLine(db, fixture.finance, {
      lineId: firstLine.id, reason: "Спор партнёра.", key: `dispute-${rid()}`,
    });
    const resolved = await resolvePartnerDispute(db, fixture.finance, {
      disputeId: dispute.disputeId,
      outcome: "upheld",
      reason: "Подтверждено приёмкой.",
      key: `resolve-${rid()}`,
    });

    // A second partner of the same tenant, with its own invoice, line and dispute.
    const otherPartner = await seedPartner(db, fixture.organizationId);
    const [ownAccrual] = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, fixture.partner.partnerId)).limit(1);
    const [otherAccrual] = await db.insert(partnerServiceAccruals).values({
      organizationId: fixture.organizationId,
      partnerId: otherPartner.partnerId,
      orderLineId: ownAccrual.orderLineId,
      contractId: fixture.partner.contractId,
      contractPriceVersionId: fixture.partner.priceVersionId,
      quantity: 1,
      amountKopeks: 100,
      status: "accrued",
    }).returning();
    const [otherInvoice] = await db.insert(partnerInvoices).values({
      organizationId: fixture.organizationId,
      partnerId: otherPartner.partnerId,
      number: `PINV-OTHER-${rid().slice(0, 8)}`,
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
      totalKopeks: 100,
    }).returning();
    const [otherLine] = await db.insert(partnerInvoiceLines).values({
      invoiceId: otherInvoice.id, accrualId: otherAccrual.id, amountKopeks: 100,
    }).returning();
    const [otherDispute] = await db.insert(partnerDisputes).values({
      organizationId: fixture.organizationId,
      invoiceLineId: otherLine.id,
      openedBy: otherPartner.userId,
      reason: "Спор другого партнёра.",
      state: "open",
    }).returning();

    const partnerPrincipal = fixture.partner.principal;
    const otherPrincipal = makePrincipal(fixture.organizationId, otherPartner.userId, ["laundry_operator"], {
      partnerId: otherPartner.partnerId,
    });
    const scoped = await listPartnerScopedDisputes(db, partnerPrincipal, {});
    expect(scoped.items.map(item => item.id)).toContain(dispute.disputeId);
    expect(scoped.items.map(item => item.id)).not.toContain(otherDispute.id);
    expect(scoped.items.every(item => item.partnerId === fixture.partner.partnerId)).toBe(true);
    // The partner learns what was decided, not which note carries it.
    expect(Object.keys(scoped.items[0])).not.toContain("creditNoteId");

    // The finance list of the tenant sees both partners.
    const financeList = await listPartnerDisputes(db, fixture.finance, {});
    expect(financeList.items.map(item => item.id)).toEqual(
      expect.arrayContaining([dispute.disputeId, otherDispute.id]),
    );

    // The credit note of this partner is visible to the partner.
    const notes = await listPartnerScopedCreditNotes(db, partnerPrincipal, { bucket: "all" });
    expect(notes.items.map(note => note.id)).toContain(resolved.creditNoteId);

    // The payouts of this partner are visible to the partner.
    await db.insert(partnerPayouts).values([
      {
        organizationId: fixture.organizationId, partnerId: fixture.partner.partnerId,
        amountKopeks: 100, state: "scheduled", createdBy: fixture.finance.userId,
      },
      {
        organizationId: fixture.organizationId, partnerId: otherPartner.partnerId,
        amountKopeks: 200, state: "scheduled", createdBy: fixture.finance.userId,
      },
    ]);
    const payouts = await listPartnerScopedPayouts(db, partnerPrincipal, { bucket: "all" });
    expect(payouts.items.map(payout => payout.partnerId)).toEqual([fixture.partner.partnerId]);
    const otherPayouts = await listPartnerScopedPayouts(db, otherPrincipal, { bucket: "all" });
    expect(otherPayouts.items.map(payout => payout.partnerId)).toEqual([otherPartner.partnerId]);

    // Another partner of the same tenant never sees this partner's dispute.
    const otherScoped = await listPartnerScopedDisputes(db, otherPrincipal, {});
    expect(otherScoped.items.map(item => item.id)).toEqual([otherDispute.id]);

    // A finance user is not a partner: the partner-scoped list refuses them.
    await expect(listPartnerScopedDisputes(db, fixture.finance, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("LA-08: the demo seed creates the partner money slice and stays idempotent", async () => {
    const summary = await seedDemo(db);
    const organizationId = summary.organizationId;
    const counts = async () => {
      const [invoices, disputes, notes, payouts] = await Promise.all([
        db.select().from(partnerInvoices).where(eq(partnerInvoices.organizationId, organizationId)),
        db.select().from(partnerDisputes).where(eq(partnerDisputes.organizationId, organizationId)),
        db.select().from(partnerCreditNotes).where(eq(partnerCreditNotes.organizationId, organizationId)),
        db.select().from(partnerPayouts).where(eq(partnerPayouts.organizationId, organizationId)),
      ]);
      return { invoices: invoices.length, disputes: disputes.length, notes: notes.length, payouts: payouts.length };
    };
    const first = await counts();
    expect(first.invoices).toBeGreaterThan(0);
    expect(first.disputes).toBeGreaterThan(0);
    expect(first.notes).toBeGreaterThan(0);
    expect(first.payouts).toBeGreaterThan(0);

    // The demo invoice of the stand covers a couple of billed lines, not the whole book.
    const demoInvoices = await db.select().from(partnerInvoices)
      .where(eq(partnerInvoices.organizationId, organizationId));
    const lineCounts = await Promise.all(demoInvoices.map(async invoice => (
      await db.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.invoiceId, invoice.id))
    ).length));
    expect(lineCounts.some(count => count >= 2 && count <= 3)).toBe(true);

    // A second seed must not duplicate a single row.
    await seedDemo(db);
    const second = await counts();
    expect(second).toEqual(first);
  });

  it("LA-01/LA-02: the ops wrappers release expired holds and drain the outbox", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const admin = makePrincipal(order.organizationId, order.dispatcher.userId, ["platform_admin"]);

    // A hold whose TTL has passed keeps the capacity of the window until somebody sweeps it.
    const hold = await holdSlot(db, {
      principal: order.principal,
      windowId: order.windowId,
      key: `hold-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    const [beforeSweep] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, order.windowId));
    expect(beforeSweep.reservedOrders).toBeGreaterThan(0);

    const swept = await expireDueHolds(db, admin);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const [afterSweep] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, order.windowId));
    expect(afterSweep.reservedOrders).toBeLessThan(beforeSweep.reservedOrders);
    const [reservation] = await db.select().from(slotReservations).where(eq(slotReservations.id, hold.reservationId));
    expect(reservation.state).toBe("expired");

    // The outbox of this tenant is delivered by the same drain the worker uses.
    await openThread(db, order.principal, {
      orderId: order.orderId,
      subject: "Событие для outbox",
      body: "Нужен ответ, чтобы событие попало в outbox.",
      key: `thread-${rid()}`,
    });
    const pending = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, order.organizationId),
      eq(outboxEvents.state, "pending"),
    ));
    expect(pending.length).toBeGreaterThan(0);

    const drained = await drainOutbox(db, admin);
    expect(drained.processed).toBeGreaterThan(0);
    expect(drained.failed).toBe(0);
    const stillPending = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, order.organizationId),
      eq(outboxEvents.state, "pending"),
    ));
    expect(stillPending).toHaveLength(0);
  });

  it("LA-05: the partner accruals carry the dispute of every line and the payable totals", async () => {
    const fixture = await seedPartnerInvoice();
    const [firstLine] = fixture.lines;
    const dispute = await disputePartnerLine(db, fixture.finance, {
      lineId: firstLine.id, reason: "Спор по строке акта.", key: `dispute-${rid()}`,
    });

    const accruals = await partnerAccruals(db, fixture.partner.principal, {});
    const invoice = accruals.invoices.find(entry => entry.id === fixture.invoice.invoiceId);
    expect(invoice).toBeDefined();
    const line = invoice!.lines.find(entry => entry.id === firstLine.id);
    expect(line?.disputeId).toBe(dispute.disputeId);
    expect(line?.disputeState).toBe("open");
    expect(accruals.payableKopeks).toBeGreaterThanOrEqual(0);
    expect(accruals.disputedKopeks).toBe(firstLine.amountKopeks);

    const otherLine = invoice!.lines.find(entry => entry.id !== firstLine.id);
    expect(otherLine?.disputeId).toBeNull();
    expect(otherLine?.disputeState).toBeNull();
  });
});
