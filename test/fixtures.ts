import type { Db } from "../src/db/client.js";
import {
  buildings, cities, customerAddresses, documentVersions, organizations,
  priceRules, serviceWindows, services, tariffPlans, tariffVersions, users,
} from "../src/db/schema.js";
import type { Principal, Role } from "../src/core/context.js";

export function makePrincipal(
  organizationId: string,
  userId: string,
  roles: Role[],
  extra: Partial<Principal> = {},
): Principal {
  return {
    organizationId,
    userId,
    roles,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

export async function seedUser(db: Db, _organizationId: string) {
  const [user] = await db.insert(users).values({
    phone: `+79${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`,
  }).returning();
  return user.id;
}

export async function seedAddress(db: Db, organizationId: string, customerId: string, buildingId: string) {
  const [address] = await db.insert(customerAddresses).values({
    organizationId, customerId, buildingId, apartment: "42",
  }).returning();
  return address.id;
}

export async function seedCatalog(db: Db, organizationId: string, termsVersion = "offer-2026-11") {
  const [service] = await db.insert(services).values({
    organizationId, code: "wash", name: "Стирка", unit: "gram",
  }).returning();
  const [plan] = await db.insert(tariffPlans).values({ organizationId, code: "base", name: "Базовый" }).returning();
  const [version] = await db.insert(tariffVersions).values({
    planId: plan.id,
    version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    termsVersion,
    snapshotJson: { organizationId, offSchedulePickupKopeks: 50_000 },
    published: true,
  }).returning();
  await db.insert(priceRules).values({
    tariffVersionId: version.id,
    serviceId: service.id,
    tier: "economy",
    unitPriceKopeks: 10,
    minQuantity: 1,
    roundingRule: "gram_up_to_100",
  });
  await db.insert(documentVersions).values({
    organizationId,
    kind: "offer",
    version: termsVersion,
    contentHash: "hash",
    bodyText: "Оферта (тест)",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { serviceId: service.id, tariffVersionId: version.id, termsVersion };
}

export async function seedWindow(
  db: Db,
  options: { capacity?: number; startsAt?: Date; endsAt?: Date; feeKopeks?: number } = {},
) {
  const [org] = await db.insert(organizations).values({ name: `Org ${Math.random().toString(36).slice(2)}` }).returning();
  const [city] = await db.insert(cities).values({ organizationId: org.id, name: "Москва" }).returning();
  const [building] = await db.insert(buildings).values({
    organizationId: org.id, cityId: city.id, address: `ул. Тестовая, ${Math.random().toString(36).slice(2)}`,
  }).returning();
  const [customer] = await db.insert(users).values({ phone: `+79${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}` }).returning();
  const [window] = await db.insert(serviceWindows).values({
    organizationId: org.id,
    buildingId: building.id,
    kind: "pickup",
    startsAt: options.startsAt ?? new Date("2026-12-01T10:00:00.000Z"),
    endsAt: options.endsAt ?? new Date("2026-12-01T12:00:00.000Z"),
    capacityOrders: options.capacity ?? 1,
    feeKopeks: options.feeKopeks ?? 0,
  }).returning();
  return { organizationId: org.id, cityId: city.id, buildingId: building.id, userId: customer.id, windowId: window.id };
}

export async function seedDeliveryWindow(db: Db, seed: { organizationId: string; buildingId: string }, capacity = 5) {
  const [window] = await db.insert(serviceWindows).values({
    organizationId: seed.organizationId,
    buildingId: seed.buildingId,
    kind: "delivery",
    startsAt: new Date("2026-12-02T10:00:00.000Z"),
    endsAt: new Date("2026-12-02T12:00:00.000Z"),
    capacityOrders: capacity,
  }).returning();
  return window.id;
}
