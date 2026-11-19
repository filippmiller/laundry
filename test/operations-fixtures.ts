import { randomUUID } from "node:crypto";
import type { Db } from "../src/db/client.js";
import {
  courierShifts, courierDevices, routes, routeStops, seals, evidenceAssets, orders,
  memberships, membershipRoles, partnerContracts, partnerPriceVersions, partners,
} from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "./fixtures.js";
import { createQuote } from "../src/services/quotes.js";
import { createOrder, scheduleOrder } from "../src/services/orders.js";
import { assignOrderToPartner } from "../src/services/partner.js";
import { holdSlot } from "../src/domain/slot-reservation.js";
import type { Principal } from "../src/core/context.js";

export const COURIER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export async function seedFullOrder(db: Db, options: { state?: "scheduled" | "pickup_assigned" } = {}) {
  const seed = await seedWindow(db, { capacity: 3 });
  const deliveryWindowId = await seedDeliveryWindow(db, seed);
  const catalog = await seedCatalog(db, seed.organizationId);
  await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
  const principal: Principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
  const dispatcher: Principal = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["dispatcher"]);
  const courierId = await seedUser(db, seed.organizationId);
  const deviceIdForFixture = randomUUID();
  const courier: Principal = makePrincipal(seed.organizationId, courierId, ["courier"], { deviceId: deviceIdForFixture });
  await db.insert(courierDevices).values({
    id: deviceIdForFixture,
    organizationId: seed.organizationId,
    courierId,
    label: "test courier device",
  }).onConflictDoNothing();

  const quote = await createQuote(db, principal, {
    buildingId: seed.buildingId,
    pickupWindowId: seed.windowId,
    deliveryWindowId,
    tariffVersionId: catalog.tariffVersionId,
    key: `quote-${Math.random().toString(36).slice(2)}`,
    lines: [{ serviceId: catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
  });
  const order = await createOrder(db, principal, {
    quoteId: quote.id,
    acceptedQuoteHash: quote.quoteHash,
    termsVersion: catalog.termsVersion,
    key: `order-${Math.random().toString(36).slice(2)}`,
  });
  const hold = await holdSlot(db, {
    principal, windowId: seed.windowId, key: `hold-${Math.random().toString(36).slice(2)}`,
    now: new Date("2026-11-16T12:00:00Z"), expiresAt: new Date("2026-11-16T12:10:00Z"),
  });
  const deliveryHold = await holdSlot(db, {
    principal, windowId: deliveryWindowId, key: `dhold-${Math.random().toString(36).slice(2)}`,
    now: new Date("2026-11-16T12:00:00Z"), expiresAt: new Date("2026-11-16T12:10:00Z"),
  });
  await scheduleOrder(db, principal, {
    orderId: order.id, pickupReservationId: hold.reservationId, deliveryReservationId: deliveryHold.reservationId,
    key: `schedule-${Math.random().toString(36).slice(2)}`,
    now: new Date("2026-11-16T12:00:00Z"),
  });

  const [shift] = await db.insert(courierShifts).values({
    organizationId: seed.organizationId,
    courierId,
    state: "active",
    startsAt: new Date("2026-12-01T09:00:00Z"),
    endsAt: new Date("2026-12-01T18:00:00Z"),
  }).returning();
  const [route] = await db.insert(routes).values({
    organizationId: seed.organizationId,
    shiftId: shift.id,
    kind: "pickup",
    plannedStart: new Date("2026-12-01T10:00:00Z"),
    plannedEnd: new Date("2026-12-01T12:00:00Z"),
  }).returning();
  const [stop] = await db.insert(routeStops).values({
    organizationId: seed.organizationId,
    routeId: route.id,
    orderId: order.id,
    buildingId: seed.buildingId,
    kind: "pickup",
    sequence: 1,
    state: "pending",
    assignedCourierId: courierId,
  }).returning();

  if (options.state === "pickup_assigned") {
    await db.update(orders).set({ lifecycleState: "pickup_assigned" }).where(eq(orders.id, order.id));
  }

  return {
    ...seed, deliveryWindowId, catalog, principal, dispatcher, courier,
    orderId: order.id, quoteId: quote.id, courierId, shiftId: shift.id, routeId: route.id, stopId: stop.id,
    deviceId: deviceIdForFixture,
  };
}

export async function seedPartner(db: Db, organizationId: string) {
  const [partner] = await db.insert(partners).values({ organizationId, name: "Прачечка" }).returning();
  const userId = await seedUser(db, organizationId);
  const [membership] = await db.insert(memberships).values({ organizationId, userId, partnerId: partner.id }).returning();
  await db.insert(membershipRoles).values({ membershipId: membership.id, role: "laundry_operator" });
  const [contract] = await db.insert(partnerContracts).values({
    partnerId: partner.id,
    version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    signed: true,
    termsJson: { wholesalePerKgKopeks: 600 },
  }).returning();
  const [priceVersion] = await db.insert(partnerPriceVersions).values({
    contractId: contract.id,
    version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    pricesJson: { wholesalePerKgKopeks: 600 },
  }).returning();
  const principal: Principal = makePrincipal(organizationId, userId, ["laundry_operator"], { partnerId: partner.id });
  return { partnerId: partner.id, contractId: contract.id, priceVersionId: priceVersion.id, userId, principal };
}

export async function seedPartnerForOrder(
  db: Db,
  order: { orderId: string; organizationId: string; dispatcher: Principal },
) {
  const partner = await seedPartner(db, order.organizationId);
  await assignOrderToPartner(db, order.dispatcher, {
    orderId: order.orderId, partnerId: partner.partnerId,
    key: `assign-partner-${Math.random().toString(36).slice(2)}`,
  });
  return partner;
}

export async function seedSeal(db: Db, organizationId: string, serial = `SEAL-${Math.random().toString(36).slice(2)}`) {
  const [seal] = await db.insert(seals).values({ organizationId, serialNumber: serial }).returning();
  return { id: seal.id, serial: seal.serialNumber };
}

export async function seedEvidence(db: Db, organizationId: string, ownerId: string) {
  const [asset] = await db.insert(evidenceAssets).values({
    organizationId,
    ownerType: "garment",
    ownerId,
    objectKey: `evidence/${Math.random().toString(36).slice(2)}.jpg`,
    sha256: "a".repeat(64),
    purpose: "intake_condition",
    status: "verified",
  }).returning();
  return asset.id;
}
