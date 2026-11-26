import { and, desc, eq, inArray, lt, max, notInArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { orderEscalations, orders, outboxEvents, partners, users } from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

/**
 * The lifecycle states an order can no longer leave. A delivered, closed or cancelled order is
 * finished, not jammed — it must never show up as a stuck order.
 */
const TERMINAL_ORDER_STATES = ["delivered", "closed", "cancelled"] as const;

/** How long an order may stand still before the dispatcher is told about it. */
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * The shortest text that can explain a jam. "завис на хабе" is a reason, "x" is not: the
 * escalation is the only record of why the order stopped, so an empty or meaningless reason
 * would leave the jam exactly as ownerless as it was before.
 */
const MIN_REASON_LENGTH = 3;

/** The states an escalation can be in. */
export type EscalationState = "open" | "resolved";

/**
 * The domain events of an escalation. They are written against the order, so the order's
 * timeline shows the whole story — but they are not progress, and the stuck list ignores them.
 */
const ESCALATION_EVENT_TYPES = ["order.escalated", "order.escalation_resolved"] as const;

export type StuckOrderEscalation = {
  id: string;
  reason: string;
  assigneeId: string | null;
  escalatedBy: string;
  createdAt: string;
};

export type StuckOrder = {
  orderId: string;
  publicNumber: string;
  lifecycleState: string;
  /** How long the order has stood still, in whole minutes. */
  idleMinutes: number;
  /** When the order was last touched — the newer of its creation and its last domain event. */
  lastActivityAt: string;
  /** The customer's display name. The phone number never leaves the database for this list. */
  customerName: string | null;
  partnerId: string | null;
  partnerName: string | null;
  /** The open escalation of this order, if there is one. */
  escalation: StuckOrderEscalation | null;
};

function escalationState(value: string): EscalationState {
  return value === "resolved" ? "resolved" : "open";
}

/** The driver hands a timestamp back as a Date; a raw aggregate may hand over a string. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The order of a tenant that stopped moving.
 *
 * "Last activity" is the newer of the order's creation and its newest domain event: every
 * transition of an order writes an event, so the newest event is the honest answer — the
 * creation time alone would report every order that ever moved as idle since the day it was
 * placed. A terminal order is never stuck, so delivered, closed and cancelled orders are left
 * out entirely.
 */
export async function listStuckOrders(
  db: Db,
  principal: Principal,
  input: { minutes?: number; onlyEscalated?: boolean } = {},
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance);
  const minutes = Math.min(Math.max(Math.trunc(input.minutes ?? DEFAULT_IDLE_MINUTES), 1), 24 * 60);
  const cutoff = new Date(Date.now() - minutes * 60_000);

  const candidates = await db.select({
    id: orders.id,
    publicNumber: orders.publicNumber,
    lifecycleState: orders.lifecycleState,
    createdAt: orders.createdAt,
    customerName: users.displayName,
    assignedPartnerId: orders.assignedPartnerId,
    partnerName: partners.name,
  }).from(orders)
    .leftJoin(users, eq(users.id, orders.customerId))
    .leftJoin(partners, eq(partners.id, orders.assignedPartnerId))
    .where(and(
      eq(orders.organizationId, principal.organizationId),
      notInArray(orders.lifecycleState, [...TERMINAL_ORDER_STATES]),
      // The creation of an order is activity too, so an order younger than the threshold
      // cannot be stuck yet. The bound keeps the list from walking the whole order history.
      lt(orders.createdAt, cutoff),
    ))
    .orderBy(desc(orders.createdAt));

  if (!candidates.length) return { thresholdMinutes: minutes, items: [] as StuckOrder[] };

  const orderIds = candidates.map(row => row.id);

  const [events, escalations] = await Promise.all([
    db.select({ orderId: outboxEvents.aggregateId, at: max(outboxEvents.createdAt) })
      .from(outboxEvents)
      .where(and(
        eq(outboxEvents.aggregateType, "order"),
        eq(outboxEvents.organizationId, principal.organizationId),
        inArray(outboxEvents.aggregateId, orderIds),
        // An escalation is a report about the jam, not progress on the order. Counting it as
        // activity would hide the very order the dispatcher escalated a minute ago.
        notInArray(outboxEvents.eventType, [...ESCALATION_EVENT_TYPES]),
      ))
      .groupBy(outboxEvents.aggregateId),
    db.select({
      id: orderEscalations.id,
      orderId: orderEscalations.orderId,
      reason: orderEscalations.reason,
      assigneeId: orderEscalations.assigneeId,
      escalatedBy: orderEscalations.escalatedBy,
      createdAt: orderEscalations.createdAt,
    }).from(orderEscalations)
      .where(and(
        eq(orderEscalations.organizationId, principal.organizationId),
        eq(orderEscalations.state, "open"),
        inArray(orderEscalations.orderId, orderIds),
      )),
  ]);

  const lastEventAt = new Map(events.map(event => [event.orderId, event.at]));
  const openEscalation = new Map(escalations.map(escalation => [escalation.orderId, escalation]));
  const now = Date.now();

  const items: StuckOrder[] = [];
  for (const candidate of candidates) {
    const createdAt = toDate(candidate.createdAt) ?? new Date(0);
    const lastEvent = toDate(lastEventAt.get(candidate.id) ?? null);
    const lastActivity = lastEvent && lastEvent > createdAt ? lastEvent : createdAt;
    const idleMinutes = Math.floor((now - lastActivity.getTime()) / 60_000);
    // The threshold is checked on the activity, not on the age of the order, so a freshly
    // moved order never appears in the list.
    if (idleMinutes < minutes) continue;

    const escalation = openEscalation.get(candidate.id) ?? null;
    if (input.onlyEscalated && !escalation) continue;

    items.push({
      orderId: candidate.id,
      publicNumber: candidate.publicNumber,
      lifecycleState: candidate.lifecycleState,
      idleMinutes,
      lastActivityAt: lastActivity.toISOString(),
      customerName: candidate.customerName?.trim() ? candidate.customerName : null,
      partnerId: candidate.assignedPartnerId ?? null,
      partnerName: candidate.partnerName ?? null,
      escalation: escalation
        ? {
          id: escalation.id,
          reason: escalation.reason,
          assigneeId: escalation.assigneeId ?? null,
          escalatedBy: escalation.escalatedBy,
          createdAt: (toDate(escalation.createdAt) ?? new Date(0)).toISOString(),
        }
        : null,
    });
  }

  // The longest jam first: that is the order that needs a person now.
  items.sort((left, right) => right.idleMinutes - left.idleMinutes);
  return { thresholdMinutes: minutes, items };
}

/** Loads an order of the tenant or fails with 404 — a foreign order must stay invisible. */
async function loadOrder(tx: Db | Tx, principal: Principal, orderId: string) {
  const [order] = await tx.select({
    id: orders.id,
    publicNumber: orders.publicNumber,
    lifecycleState: orders.lifecycleState,
  }).from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.organizationId, principal.organizationId),
  )).limit(1);
  if (!order) throw errors.notFound("order");
  return order;
}

/**
 * Escalates a stuck order: it names the person who noticed the jam, the reason and, when the
 * dispatcher knows it, the person who owns the fix.
 *
 * The order is locked for the transaction, so two dispatchers pressing the button at the same
 * moment cannot open two escalations of the same order. The second request returns the
 * escalation that is already open instead of a second jam record.
 */
export async function escalateOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; reason: string; assigneeId?: string | null; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  const reason = input.reason?.trim() ?? "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppError("VALIDATION_ERROR", "ESCALATION_REASON_REQUIRED");
  }
  const assigneeId = input.assigneeId ?? null;

  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "orders:escalation",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ orderId: input.orderId, reason, assigneeId, actorId: principal.userId }),
    replayGuard: async tx => { await loadOrder(tx, principal, input.orderId); },
  }, async tx => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(and(
      eq(orders.id, input.orderId),
      eq(orders.organizationId, principal.organizationId),
    )).for("update").limit(1);
    if (!order) throw errors.notFound("order");

    if (assigneeId) {
      const [assignee] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, assigneeId)).limit(1);
      if (!assignee) throw errors.notFound("user");
    }

    const [alreadyOpen] = await tx.select({
      id: orderEscalations.id,
      state: orderEscalations.state,
      reason: orderEscalations.reason,
      assigneeId: orderEscalations.assigneeId,
      createdAt: orderEscalations.createdAt,
    }).from(orderEscalations).where(and(
      eq(orderEscalations.organizationId, principal.organizationId),
      eq(orderEscalations.orderId, order.id),
      eq(orderEscalations.state, "open"),
    )).for("update").limit(1);
    if (alreadyOpen) {
      // The order is already escalated. A second open escalation would hide the real one,
      // so the existing record is returned and the jam keeps a single owner.
      return {
        escalationId: alreadyOpen.id,
        orderId: order.id,
        state: escalationState(alreadyOpen.state),
        reason: alreadyOpen.reason,
        assigneeId: alreadyOpen.assigneeId ?? null,
        created: false,
        createdAt: (toDate(alreadyOpen.createdAt) ?? new Date(0)).toISOString(),
      };
    }

    const [escalation] = await tx.insert(orderEscalations).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      escalatedBy: principal.userId,
      reason,
      assigneeId,
      state: "open",
    }).returning();

    await appendEvent(tx, {
      principal,
      aggregateType: "order",
      aggregateId: order.id,
      eventType: "order.escalated",
      payload: { escalationId: escalation.id, reason, assigneeId },
      reason,
    });

    return {
      escalationId: escalation.id,
      orderId: order.id,
      state: "open" as EscalationState,
      reason,
      assigneeId,
      created: true,
      createdAt: (toDate(escalation.createdAt) ?? new Date(0)).toISOString(),
    };
  });
}

/**
 * Closes an escalation: it records what was done, who did it and when, so the jam leaves a
 * trace instead of simply disappearing from the list.
 */
export async function resolveEscalation(
  db: Db,
  principal: Principal,
  input: { escalationId: string; resolution: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  const resolution = input.resolution?.trim() ?? "";
  if (resolution.length < MIN_REASON_LENGTH) {
    throw new AppError("VALIDATION_ERROR", "ESCALATION_RESOLUTION_REQUIRED");
  }

  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "orders:escalation:resolve",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ escalationId: input.escalationId, resolution, actorId: principal.userId }),
    replayGuard: async tx => {
      const [escalation] = await tx.select({ id: orderEscalations.id }).from(orderEscalations).where(and(
        eq(orderEscalations.id, input.escalationId),
        eq(orderEscalations.organizationId, principal.organizationId),
      )).limit(1);
      if (!escalation) throw errors.notFound("escalation");
    },
  }, async tx => {
    const [escalation] = await tx.select({
      id: orderEscalations.id,
      orderId: orderEscalations.orderId,
      state: orderEscalations.state,
    }).from(orderEscalations).where(and(
      eq(orderEscalations.id, input.escalationId),
      eq(orderEscalations.organizationId, principal.organizationId),
    )).for("update").limit(1);
    if (!escalation) throw errors.notFound("escalation");
    if (escalation.state !== "open") {
      throw new AppError("CONFLICT_VERSION", "ESCALATION_ALREADY_RESOLVED", { state: escalation.state });
    }

    const resolvedAt = new Date();
    const [resolved] = await tx.update(orderEscalations).set({
      state: "resolved",
      resolution,
      resolvedBy: principal.userId,
      resolvedAt,
      updatedAt: resolvedAt,
    }).where(and(
      eq(orderEscalations.id, escalation.id),
      eq(orderEscalations.state, "open"),
    )).returning({ id: orderEscalations.id });
    if (!resolved) throw new AppError("CONFLICT_VERSION", "ESCALATION_ALREADY_RESOLVED");

    await appendEvent(tx, {
      principal,
      aggregateType: "order",
      aggregateId: escalation.orderId,
      eventType: "order.escalation_resolved",
      payload: { escalationId: escalation.id, resolution },
      reason: resolution,
    });

    return {
      escalationId: escalation.id,
      orderId: escalation.orderId,
      state: "resolved" as EscalationState,
      resolution,
      resolvedBy: principal.userId,
      resolvedAt: resolvedAt.toISOString(),
    };
  });
}
