import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  documentVersions, orderLines, orders, quotes, serviceWindows, slotReservations,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency } from "../core/idempotency.js";
import { nextState, type OrderState } from "../domain/order-state.js";
import { confirmSlot } from "../domain/slot-reservation.js";
import { assertAcceptableQuote } from "./quotes.js";

type QuoteSnapshot = {
  addressId?: string;
  lines: Array<{ kind: string; serviceId?: string; tier?: "economy" | "protected"; quantity: number; unit: string; amountKopeks: number }>;
};

export async function createOrder(
  db: Db,
  principal: Principal,
  input: { quoteId: string; acceptedQuoteHash: string; termsVersion: string; key: string; now?: Date },
) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const now = input.now ?? new Date();
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:create",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, principalId: principal.userId }),
  }, async tx => {
    const quote = await assertAcceptableQuote(tx as Db, principal, input.quoteId, input.acceptedQuoteHash, now);
    const [document] = await tx.select().from(documentVersions).where(and(
      eq(documentVersions.organizationId, principal.organizationId),
      eq(documentVersions.kind, "offer"),
      eq(documentVersions.version, input.termsVersion),
    )).limit(1);
    if (!document?.publishedAt) throw new AppError("VALIDATION_ERROR", "TERMS_NOT_PUBLISHED");
    const snapshot = quote.snapshotJson as QuoteSnapshot;
    const serviceLines = snapshot.lines.filter(line => line.kind === "service");
    if (!serviceLines.length) throw new AppError("VALIDATION_ERROR", "NO_SERVICE_LINES");

    const publicNumber = `LA-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const [order] = await tx.insert(orders).values({
      organizationId: principal.organizationId,
      customerId: quote.customerId,
      addressId: (() => {
        const addressId = (quote.snapshotJson as QuoteSnapshot).addressId;
        if (!addressId) throw new AppError("VALIDATION_ERROR", "CUSTOMER_ADDRESS_REQUIRED");
        return addressId;
      })(),
      quoteId: quote.id,
      publicNumber,
      lifecycleState: "draft",
      termsVersion: input.termsVersion,
      acceptedQuoteHash: input.acceptedQuoteHash,
    }).returning();

    await tx.insert(orderLines).values(serviceLines.map(line => ({
      orderId: order.id,
      serviceId: line.serviceId!,
      tier: line.tier!,
      quotedQuantity: line.quantity,
      unit: line.unit,
      quotedAmountKopeks: line.amountKopeks,
      tariffSnapshotJson: { quoteId: quote.id, tariffVersionId: quote.tariffVersionId, line },
    })));

    await tx.update(orders).set({ lifecycleState: nextState("draft", "confirm", principal), version: sql`${orders.version} + 1` })
      .where(eq(orders.id, order.id));
    await tx.update(quotes).set({ state: "accepted" }).where(eq(quotes.id, quote.id));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.confirmed",
      payload: { quoteId: quote.id, totalKopeks: quote.totalKopeks, termsVersion: input.termsVersion },
    });
    return {
      id: order.id,
      publicNumber: order.publicNumber,
      organizationId: order.organizationId,
      customerId: order.customerId,
      state: "confirmed" as const,
      totalKopeks: quote.totalKopeks,
      quoteId: quote.id,
    };
  });
  return { ...result.value, replayed: result.replayed };
}

export async function scheduleOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; pickupReservationId?: string; deliveryReservationId?: string; key: string; now?: Date },
) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:schedule",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const order = await loadOrder(tx as Db, principal, input.orderId);
    if (order.lifecycleState !== "confirmed") throw errors.transition(order.lifecycleState, "reserve_pickup");
    for (const reservationId of [input.pickupReservationId, input.deliveryReservationId].filter(Boolean) as string[]) {
      const [reservation] = await tx.select().from(slotReservations).where(and(
        eq(slotReservations.id, reservationId),
        eq(slotReservations.organizationId, principal.organizationId),
      )).limit(1);
      if (!reservation) throw errors.notFound("reservation");
      const [window] = await tx.select().from(serviceWindows).where(eq(serviceWindows.id, reservation.windowId)).limit(1);
      if (!window) throw errors.notFound("window");
      if (reservation.orderId && reservation.orderId !== order.id) throw errors.notFound("reservation");
      await confirmSlot(tx as Db, {
        principal, reservationId, key: `schedule-${input.key}-${reservationId}`, now: input.now,
      });
      await tx.update(slotReservations).set({ orderId: order.id }).where(eq(slotReservations.id, reservationId));
    }
    await tx.update(orders).set({
      lifecycleState: "scheduled",
      version: sql`${orders.version} + 1`,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.scheduled",
      payload: { pickupReservationId: input.pickupReservationId ?? null, deliveryReservationId: input.deliveryReservationId ?? null },
    });
    return { id: order.id, state: "scheduled" as const };
  });
  return { ...result.value, replayed: result.replayed };
}

export async function loadOrder(db: Db, principal: Principal, orderId: string) {
  const [order] = await db.select().from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.organizationId, principal.organizationId),
  )).limit(1);
  if (!order) throw errors.notFound("order");
  if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");
  return order;
}

export async function transitionOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; command: string; reason?: string; key: string },
) {
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:transition",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const order = await loadOrder(tx as Db, principal, input.orderId);
    const to = nextState(order.lifecycleState as OrderState, input.command, principal);
    const updated = await tx.update(orders).set({
      lifecycleState: to,
      version: sql`${orders.version} + 1`,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version))).returning({ version: orders.version });
    if (!updated.length) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: `order.${input.command}`, reason: input.reason,
      payload: { from: order.lifecycleState, to, version: updated[0].version },
    });
    return { id: order.id, from: order.lifecycleState, to, version: updated[0].version };
  });
  return { ...result.value, replayed: result.replayed };
}

export async function getOrderTimeline(db: Db, principal: Principal, orderId: string) {
  await loadOrder(db, principal, orderId);
  const rows = await db.execute(sql`
    SELECT event_type, payload_json, created_at FROM outbox_events
    WHERE organization_id = ${principal.organizationId} AND aggregate_type = 'order'
      AND aggregate_id = ${orderId}
    ORDER BY created_at ASC
  `);
  return rows.rows;
}
