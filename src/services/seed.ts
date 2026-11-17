import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  buildings, cities, courierShifts, customerAddresses, documentVersions, membershipRoles, memberships,
  organizations, partnerContracts, partners, priceRules, seals, serviceWindows, services,
  tariffPlans, tariffVersions, users,
} from "../db/schema.js";
import type { Role } from "../core/context.js";
import { AppError } from "../core/errors.js";

const DEMO_NAME = "Демо-прачечная";
const TERMS = "offer-demo-2026-11";

const DEMO_PERSONAS: Array<{ role: Role; phone: string; displayName: string }> = [
  { role: "customer", phone: "+79990000001", displayName: "Анна" },
  { role: "courier", phone: "+79990000002", displayName: "Курьер Илья" },
  { role: "dispatcher", phone: "+79990000003", displayName: "Диспетчер Мария" },
  { role: "laundry_operator", phone: "+79990000004", displayName: "Прачечная" },
  { role: "platform_finance", phone: "+79990000005", displayName: "Финансы" },
  { role: "claims_approver", phone: "+79990000006", displayName: "Претензии" },
  { role: "customer_support", phone: "+79990000007", displayName: "Поддержка Ольга" },
  { role: "platform_admin", phone: "+79990000008", displayName: "Администратор" },
];

export async function seedDemo(db: Db, options?: { previewAuthorized?: boolean }) {
  if (
    process.env.NODE_ENV === "production"
    && !(process.env.PREVIEW_MODE === "enabled" && options?.previewAuthorized === true)
  ) {
    throw new AppError("UNAUTHORIZED", "DEMO_SEED_DISABLED");
  }
  const [existing] = await db.select().from(organizations).where(eq(organizations.name, DEMO_NAME)).limit(1);
  if (existing) return demoSummary(db, existing.id);

  const [org] = await db.insert(organizations).values({ name: DEMO_NAME, legalName: "ООО «Демо»" }).returning();
  const [city] = await db.insert(cities).values({ organizationId: org.id, name: "Москва" }).returning();
  const [building1] = await db.insert(buildings).values({
    organizationId: org.id, cityId: city.id, address: "ул. Примерная, 12", timezone: "Europe/Moscow",
  }).returning();
  const [building2] = await db.insert(buildings).values({
    organizationId: org.id, cityId: city.id, address: "ЖК «Скандинавия», корп. 3", timezone: "Europe/Moscow",
  }).returning();

  const pickupStartsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pickupEndsAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const deliveryStartsAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
  const deliveryEndsAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000);

  const [pickup1] = await db.insert(serviceWindows).values({
    organizationId: org.id, buildingId: building1.id, kind: "pickup", isShared: true,
    startsAt: pickupStartsAt, endsAt: pickupEndsAt, capacityOrders: 20, feeKopeks: 0, status: "open",
  }).returning();
  const [delivery1] = await db.insert(serviceWindows).values({
    organizationId: org.id, buildingId: building1.id, kind: "delivery", isShared: true,
    startsAt: deliveryStartsAt, endsAt: deliveryEndsAt, capacityOrders: 20, feeKopeks: 0, status: "open",
  }).returning();
  await db.insert(serviceWindows).values([
    {
      organizationId: org.id, buildingId: building2.id, kind: "pickup", isShared: true,
      startsAt: pickupStartsAt, endsAt: pickupEndsAt, capacityOrders: 20, feeKopeks: 0, status: "open",
    },
    {
      organizationId: org.id, buildingId: building2.id, kind: "delivery", isShared: true,
      startsAt: deliveryStartsAt, endsAt: deliveryEndsAt, capacityOrders: 20, feeKopeks: 0, status: "open",
    },
  ]);

  const [customer] = await db.insert(users).values({ phone: "+79990000001", displayName: "Анна" }).returning();
  await db.insert(customerAddresses).values({
    organizationId: org.id, customerId: customer.id, buildingId: building1.id, apartment: "42",
  });
  const demos = DEMO_PERSONAS;
  const [partner] = await db.insert(partners).values({ organizationId: org.id, name: "Прачечка №1" }).returning();
  for (const demo of demos) {
    let [user] = await db.select().from(users).where(eq(users.phone, demo.phone)).limit(1);
    if (!user) {
      [user] = await db.insert(users).values({ phone: demo.phone, displayName: demo.displayName }).returning();
    }
    const [membership] = await db.insert(memberships).values({
      organizationId: org.id, userId: user.id,
      partnerId: demo.role === "laundry_operator" ? partner.id : null,
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: membership.id, role: demo.role });
  }
  await db.insert(partnerContracts).values({
    partnerId: partner.id, version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"), signed: true,
    termsJson: { wholesalePerKgKopeks: 600 },
  });
  const [courierUser] = await db.select().from(users).where(eq(users.phone, "+79990000002")).limit(1);
  const [existingShift] = await db.select().from(courierShifts).where(and(
    eq(courierShifts.organizationId, org.id), eq(courierShifts.courierId, courierUser.id),
  )).limit(1);
  if (!existingShift) {
    await db.insert(courierShifts).values({
      organizationId: org.id, courierId: courierUser.id, state: "active",
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 10 * 60 * 60 * 1000),
    });
  }
  for (let index = 1; index <= 20; index++) {
    await db.insert(seals).values({
      organizationId: org.id, serialNumber: `DEMO-SEAL-${String(index).padStart(3, "0")}`,
    }).onConflictDoNothing();
  }

  const [wash] = await db.insert(services).values({
    organizationId: org.id, code: "wash", name: "Стирка повседневная", unit: "gram",
    description: "Стирка повседневных вещей, от 1 кг",
  }).returning();
  const [delicate] = await db.insert(services).values({
    organizationId: org.id, code: "delicate", name: "Бережная стирка", unit: "gram",
    description: "Деликатная стирка при низкой температуре, от 1 кг",
  }).returning();
  const [ironing] = await db.insert(services).values({
    organizationId: org.id, code: "ironing", name: "Глажка", unit: "piece",
    description: "Глажка одной вещи",
  }).returning();
  const [outerwear] = await db.insert(services).values({
    organizationId: org.id, code: "outerwear", name: "Химчистка верхней одежды", unit: "piece",
    description: "Чистка пальто, пуховиков и верхней одежды",
  }).returning();
  const [plan] = await db.insert(tariffPlans).values({ organizationId: org.id, code: "base", name: "Базовый" }).returning();
  const [version] = await db.insert(tariffVersions).values({
    planId: plan.id, version: "v1", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    termsVersion: TERMS, published: true,
    offSchedulePickupKopeks: 50_000, offScheduleDeliveryKopeks: 50_000,
    snapshotJson: { currency: "RUB", note: "Цены демонстрационные, не утверждённый тариф" },
  }).returning();
  await db.insert(priceRules).values([
    { tariffVersionId: version.id, serviceId: wash.id, tier: "economy", unitPriceKopeks: 10, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
    { tariffVersionId: version.id, serviceId: wash.id, tier: "protected", unitPriceKopeks: 18, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
    { tariffVersionId: version.id, serviceId: delicate.id, tier: "economy", unitPriceKopeks: 16, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
    { tariffVersionId: version.id, serviceId: delicate.id, tier: "protected", unitPriceKopeks: 24, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
    { tariffVersionId: version.id, serviceId: ironing.id, tier: "economy", unitPriceKopeks: 15_000, minQuantity: 1 },
    { tariffVersionId: version.id, serviceId: ironing.id, tier: "protected", unitPriceKopeks: 22_000, minQuantity: 1 },
    { tariffVersionId: version.id, serviceId: outerwear.id, tier: "economy", unitPriceKopeks: 95_000, minQuantity: 1 },
    { tariffVersionId: version.id, serviceId: outerwear.id, tier: "protected", unitPriceKopeks: 135_000, minQuantity: 1 },
  ]);
  await db.insert(documentVersions).values({
    organizationId: org.id, kind: "offer", version: TERMS,
    contentHash: "demo-offer-hash", bodyText: "Демонстрационная оферта. Условия требуют проверки юристом.",
    publishedAt: new Date(),
  });

  return demoSummary(db, org.id, {
    buildingId: building1.id, pickupWindowId: pickup1.id, deliveryWindowId: delivery1.id,
    tariffVersionId: version.id, serviceId: wash.id, ironingServiceId: ironing.id, termsVersion: TERMS,
  });
}

async function demoSummary(
  db: Db,
  organizationId: string,
  extra: Record<string, string> = {},
) {
  const [buildingRows, windowRows, serviceRows, partnerRows, [version], [shift]] = await Promise.all([
    db.select().from(buildings).where(eq(buildings.organizationId, organizationId)).orderBy(asc(buildings.address)),
    db.select().from(serviceWindows).where(eq(serviceWindows.organizationId, organizationId)),
    db.select().from(services).where(eq(services.organizationId, organizationId)),
    db.select().from(partners).where(eq(partners.organizationId, organizationId)),
    db.select({ id: tariffVersions.id, termsVersion: tariffVersions.termsVersion })
      .from(tariffVersions)
      .innerJoin(tariffPlans, eq(tariffVersions.planId, tariffPlans.id))
      .where(eq(tariffPlans.organizationId, organizationId)).limit(1),
    db.select().from(courierShifts).where(eq(courierShifts.organizationId, organizationId)).limit(1),
  ]);

  const primaryBuilding = buildingRows.find(b => b.address === "ул. Примерная, 12") ?? buildingRows[0];
  const primaryPickup = windowRows.find(w => w.buildingId === primaryBuilding?.id && w.kind === "pickup")
    ?? windowRows.find(w => w.kind === "pickup");
  const primaryDelivery = windowRows.find(w => w.buildingId === primaryBuilding?.id && w.kind === "delivery")
    ?? windowRows.find(w => w.kind === "delivery");
  const wash = serviceRows.find(s => s.code === "wash") ?? serviceRows[0];

  return {
    organizationId,
    buildingId: extra.buildingId ?? primaryBuilding?.id,
    pickupWindowId: extra.pickupWindowId ?? primaryPickup?.id,
    deliveryWindowId: extra.deliveryWindowId ?? primaryDelivery?.id,
    tariffVersionId: extra.tariffVersionId ?? version?.id,
    serviceId: extra.serviceId ?? wash?.id,
    termsVersion: extra.termsVersion ?? version?.termsVersion ?? TERMS,
    shiftId: shift?.id,
    demoUsers: DEMO_PERSONAS.map(({ role, phone }) => ({ role, phone })),
    buildings: buildingRows.map(b => ({
      id: b.id,
      address: b.address,
      pickupWindowId: windowRows.find(w => w.buildingId === b.id && w.kind === "pickup")?.id ?? null,
      deliveryWindowId: windowRows.find(w => w.buildingId === b.id && w.kind === "delivery")?.id ?? null,
    })),
    services: serviceRows.map(s => ({
      id: s.id,
      code: s.code,
      name: s.name,
      unit: s.unit,
    })),
    partners: partnerRows.map(p => ({
      id: p.id,
      name: p.name,
    })),
  };
}
