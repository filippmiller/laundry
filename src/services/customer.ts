import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buildings, cities, customerAddresses, entrances, notifications, orders, outboxEvents } from "../db/schema.js";
import { assertRole, type Principal } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const STAFF_ROLES = ["courier", "dispatcher", "laundry_operator", "platform_finance",
  "claims_approver", "customer_support", "platform_admin", "security_auditor"] as const;

/** Address book of the signed-in customer; courier-facing notes stay optional. */
export async function listAddresses(db: Db, principal: Principal) {
  assertRole(principal, "customer");
  return db.select({
    id: customerAddresses.id,
    buildingId: customerAddresses.buildingId,
    entranceId: customerAddresses.entranceId,
    apartment: customerAddresses.apartment,
    notes: customerAddresses.notes,
    buildingAddress: buildings.address,
    city: cities.name,
    createdAt: customerAddresses.createdAt,
  }).from(customerAddresses)
    .innerJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
    .innerJoin(cities, eq(cities.id, buildings.cityId))
    .where(and(
      eq(customerAddresses.organizationId, principal.organizationId),
      eq(customerAddresses.customerId, principal.userId),
    ))
    .orderBy(desc(customerAddresses.createdAt));
}

export async function addAddress(
  db: Db,
  principal: Principal,
  input: { buildingId: string; entranceId?: string; apartment?: string; notes?: string; key: string },
) {
  assertRole(principal, "customer");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "addresses:add", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [building] = await tx.select({ id: buildings.id }).from(buildings).where(and(
      eq(buildings.id, input.buildingId),
      eq(buildings.organizationId, principal.organizationId),
    )).limit(1);
    if (!building) throw errors.notFound("building");
    if (input.entranceId) {
      const [entrance] = await tx.select({ id: entrances.id }).from(entrances).where(and(
        eq(entrances.id, input.entranceId),
        eq(entrances.buildingId, input.buildingId),
      )).limit(1);
      if (!entrance) throw errors.notFound("entrance");
    }
    const [address] = await tx.insert(customerAddresses).values({
      organizationId: principal.organizationId,
      customerId: principal.userId,
      buildingId: input.buildingId,
      entranceId: input.entranceId ?? null,
      apartment: input.apartment ?? null,
      // Door codes are intentionally not accepted until an encryption path exists.
      doorCodeEncrypted: null,
      notes: input.notes ?? null,
    }).returning();
    return { addressId: address.id, buildingId: address.buildingId };
  });
}

export async function removeAddress(db: Db, principal: Principal, addressId: string) {
  assertRole(principal, "customer");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "addresses:remove", key: addressId, actorId: principal.userId,
    requestHash: hashRequest({ addressId, actorId: principal.userId }),
  }, async tx => {
    // An order still points at the address. The foreign key would refuse the delete and the
    // client would see an unexplained 500 instead of a conflict it can act on.
    const [referencing] = await tx.select({ id: orders.id }).from(orders)
      .where(eq(orders.addressId, addressId)).limit(1);
    if (referencing) {
      throw new AppError("CONFLICT_VERSION", "ADDRESS_IN_USE", { orderId: referencing.id });
    }
    const deleted = await tx.delete(customerAddresses).where(and(
      eq(customerAddresses.id, addressId),
      eq(customerAddresses.organizationId, principal.organizationId),
      eq(customerAddresses.customerId, principal.userId),
    )).returning({ id: customerAddresses.id });
    if (!deleted.length) throw errors.notFound("address");
    return { addressId: deleted[0].id, removed: true as const };
  });
}

/**
 * Notification feed of the signed-in principal: every channel row the platform produced for
 * this user, newest first; unread ones carry readAt = null.
 */
export async function listNotifications(db: Db, principal: Principal) {
  assertRole(principal, "customer", ...STAFF_ROLES);
  const rows = await db.select({
    id: notifications.id,
    orderId: notifications.orderId,
    channel: notifications.channel,
    template: notifications.template,
    payloadJson: notifications.payloadJson,
    readAt: notifications.readAt,
    createdAt: notifications.createdAt,
  }).from(notifications)
    .where(and(
      eq(notifications.organizationId, principal.organizationId),
      eq(notifications.recipientId, principal.userId),
    ))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  return rows.map(row => ({
    ...row,
    payloadJson: row.payloadJson as Record<string, unknown>,
    read: row.readAt !== null,
  }));
}

export async function markNotificationsRead(db: Db, principal: Principal, input: { ids: string[] }) {
  assertRole(principal, "customer", ...STAFF_ROLES);
  if (!input.ids.length) return { marked: 0 };
  let marked = 0;
  for (const id of input.ids) {
    const updated = await db.update(notifications).set({ readAt: new Date() }).where(and(
      eq(notifications.id, id),
      eq(notifications.organizationId, principal.organizationId),
      eq(notifications.recipientId, principal.userId),
      isNull(notifications.readAt),
    )).returning({ id: notifications.id });
    marked += updated.length;
  }
  return { marked };
}

/**
 * No-login tracking: the caller must know both the public number and the exact customer phone.
 * A wrong phone is indistinguishable from an unknown order — no enumeration oracle — and the
 * projection deliberately excludes every personal field.
 */
export async function trackOrder(
  db: Db,
  organizationId: string,
  input: { publicNumber: string; phone: string },
) {
  const [order] = await db.select({
    id: orders.id,
    publicNumber: orders.publicNumber,
    lifecycleState: orders.lifecycleState,
    createdAt: orders.createdAt,
    customerId: orders.customerId,
  }).from(orders).where(and(
    eq(orders.organizationId, organizationId),
    eq(orders.publicNumber, input.publicNumber.trim().toUpperCase()),
  )).limit(1);
  if (!order) throw new AppError("NOT_FOUND", "NOT_FOUND", { resource: "order" });
  const matches = await db.execute(sql`
    SELECT 1 FROM users WHERE id = ${order.customerId} AND phone = ${input.phone.trim()} LIMIT 1
  `);
  if (!(matches.rows as unknown[]).length) {
    throw new AppError("NOT_FOUND", "NOT_FOUND", { resource: "order" });
  }
  // "Last update" is the last state change, not the moment the order was created: every
  // transition of the order writes an event, so the newest one is the honest answer. Reporting
  // `createdAt` showed a stale timestamp for every order that had ever moved.
  const [lastEvent] = await db.select({ at: outboxEvents.createdAt })
    .from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, order.id),
    )).orderBy(desc(outboxEvents.createdAt)).limit(1);
  return {
    publicNumber: order.publicNumber,
    state: order.lifecycleState,
    updatedAt: lastEvent?.at ?? order.createdAt,
  };
}
