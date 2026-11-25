import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbLike } from "../db/client.js";
import {
  buildings, cities, courierShifts, customerAddresses, documentVersions, membershipRoles, memberships,
  organizations, partnerContracts, partnerPriceVersions, partners, priceRules, seals, serviceWindows, services,
  tariffPlans, tariffVersions, users,
} from "../db/schema.js";
import { AppError } from "../core/errors.js";
import { seedDemoTenantBook, DEMO_PERSONAS, isDemoPartnerRole } from "./demo-book.js";
const DEMO_NAME = "Демо-прачечная";
const TERMS = "offer-demo-2026-11";

/**
 * The demo tariff.
 *
 * `unitPriceKopeks` is per 100 g (the `gram_up_to_100` rounding rule), so 9_000 means 900 ₽ per
 * kilogram. The figures are demonstrative, not an approved tariff, but they are deliberately in a
 * plausible range: a partner's wholesale is 600 ₽/kg, so a demo price far below that would make
 * every margin, receivable and take-rate figure in the product read as nonsense.
 */
const DEMO_PRICE_RULES = (
  tariffVersionId: string,
  ids: { wash: string; delicate: string; ironing: string; outerwear: string },
) => [
  { tariffVersionId, serviceId: ids.wash, tier: "economy" as const, unitPriceKopeks: 9_000, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
  { tariffVersionId, serviceId: ids.wash, tier: "protected" as const, unitPriceKopeks: 13_000, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
  { tariffVersionId, serviceId: ids.delicate, tier: "economy" as const, unitPriceKopeks: 12_000, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
  { tariffVersionId, serviceId: ids.delicate, tier: "protected" as const, unitPriceKopeks: 18_000, minQuantity: 1_000, roundingRule: "gram_up_to_100" },
  { tariffVersionId, serviceId: ids.ironing, tier: "economy" as const, unitPriceKopeks: 15_000, minQuantity: 1, roundingRule: "exact" },
  { tariffVersionId, serviceId: ids.ironing, tier: "protected" as const, unitPriceKopeks: 22_000, minQuantity: 1, roundingRule: "exact" },
  { tariffVersionId, serviceId: ids.outerwear, tier: "economy" as const, unitPriceKopeks: 95_000, minQuantity: 1, roundingRule: "exact" },
  { tariffVersionId, serviceId: ids.outerwear, tier: "protected" as const, unitPriceKopeks: 135_000, minQuantity: 1, roundingRule: "exact" },
];

/** The partner's wholesale: 600 ₽ per kilogram, expressed in kopeks like every other amount. */
const DEMO_WHOLESALE = {
  wholesalePerKgKopeks: 60_000,
  wholesalePerPieceKopeks: 12_000,
};

/**
 * Brings an existing demo tenant's economics in line with the demo tariff.
 *
 * A tenant seeded by an older build still carries that build's price rules and contract terms, so
 * the demo book would otherwise be priced at whatever the old rules said — which for the original
 * seed was about 1 ₽ per kilogram, making every financial figure in the product nonsense. This
 * touches only the demo tenant.
 */
async function ensureDemoEconomics(db: DbLike, organizationId: string): Promise<void> {
  const serviceRows = await db.select({ id: services.id, code: services.code }).from(services)
    .where(eq(services.organizationId, organizationId));
  const byCode = new Map(serviceRows.map(row => [row.code, row.id]));
  const wash = byCode.get("wash");
  const delicate = byCode.get("delicate");
  const ironing = byCode.get("ironing");
  const outerwear = byCode.get("outerwear");
  if (!wash || !delicate || !ironing || !outerwear) return;

  const [version] = await db.select({ id: tariffVersions.id }).from(tariffVersions)
    .innerJoin(tariffPlans, eq(tariffVersions.planId, tariffPlans.id))
    .where(and(
      eq(tariffPlans.organizationId, organizationId),
      eq(tariffVersions.published, true),
    )).limit(1);
  if (!version) return;

  for (const rule of DEMO_PRICE_RULES(version.id, { wash, delicate, ironing, outerwear })) {
    await db.insert(priceRules).values(rule).onConflictDoUpdate({
      target: [priceRules.tariffVersionId, priceRules.serviceId, priceRules.tier],
      set: {
        unitPriceKopeks: rule.unitPriceKopeks,
        minQuantity: rule.minQuantity,
        roundingRule: rule.roundingRule,
        active: true,
      },
    });
  }

  const [contract] = await db.select({ id: partnerContracts.id }).from(partnerContracts)
    .innerJoin(partners, eq(partnerContracts.partnerId, partners.id))
    .where(and(
      eq(partners.organizationId, organizationId),
      eq(partnerContracts.version, "v1"),
    )).limit(1);
  if (contract) {
    await db.update(partnerContracts).set({ termsJson: DEMO_WHOLESALE }).where(eq(partnerContracts.id, contract.id));
    await db.insert(partnerPriceVersions).values({
      contractId: contract.id,
      version: "v1",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      pricesJson: DEMO_WHOLESALE,
    }).onConflictDoUpdate({
      target: [partnerPriceVersions.contractId, partnerPriceVersions.version],
      set: { pricesJson: DEMO_WHOLESALE },
    });
  }

  // Keep demo tenant service windows open with ample headroom so repeat demo visits and live smoke
  // runs never exhaust the original 20-order window capacity. Do NOT mutate endsAt: demo-book
  // idempotency keys fingerprint window.endsAt as the hold expiry.
  await db.update(serviceWindows).set({
    capacityOrders: sql`GREATEST(${serviceWindows.capacityOrders}, ${serviceWindows.reservedOrders} + ${serviceWindows.safetyBufferOrders} + 50, 200)`,
    status: "open",
  }).where(eq(serviceWindows.organizationId, organizationId));
}

export async function seedDemo(db: Db, options?: { previewAuthorized?: boolean }) {
  if (
    process.env.NODE_ENV === "production"
    && !(process.env.PREVIEW_MODE === "enabled" && options?.previewAuthorized === true)
  ) {
    throw new AppError("UNAUTHORIZED", "DEMO_SEED_DISABLED");
  }
  // The demo tenant is created on demand, and in the preview profile the endpoint is public:
  // two visitors (or two tabs of the same visitor) can ask for it at the same moment. Without a
  // lock the second call collides with the first one on the unique indexes and the caller gets a
  // 409 instead of the demo book. The advisory lock makes the second caller wait for the first
  // one and then find the tenant that is already there.
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('laundry:seed-demo'))`);
    return seedDemoInTransaction(tx);
  });
}

async function seedDemoInTransaction(db: DbLike) {
  const [existing] = await db.select().from(organizations).where(eq(organizations.name, DEMO_NAME)).limit(1);
  if (existing) return seedBookForExistingTenant(db, existing.id);

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
    startsAt: pickupStartsAt, endsAt: pickupEndsAt, capacityOrders: 200, feeKopeks: 0, status: "open",
  }).returning();
  const [delivery1] = await db.insert(serviceWindows).values({
    organizationId: org.id, buildingId: building1.id, kind: "delivery", isShared: true,
    startsAt: deliveryStartsAt, endsAt: deliveryEndsAt, capacityOrders: 200, feeKopeks: 0, status: "open",
  }).returning();
  await db.insert(serviceWindows).values([
    {
      organizationId: org.id, buildingId: building2.id, kind: "pickup", isShared: true,
      startsAt: pickupStartsAt, endsAt: pickupEndsAt, capacityOrders: 200, feeKopeks: 0, status: "open",
    },
    {
      organizationId: org.id, buildingId: building2.id, kind: "delivery", isShared: true,
      startsAt: deliveryStartsAt, endsAt: deliveryEndsAt, capacityOrders: 200, feeKopeks: 0, status: "open",
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
      partnerId: isDemoPartnerRole(demo.role) ? partner.id : null,
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: membership.id, role: demo.role });
  }
  const [demoContract] = await db.insert(partnerContracts).values({
    partnerId: partner.id, version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"), signed: true,
    // Wholesale is 600 ₽ per kilogram — expressed in kopeks, like every other amount in the
    // system. The demo retail tariff is 900–1300 ₽/kg, so a demo order shows a plausible margin
    // instead of an absurd one.
    termsJson: DEMO_WHOLESALE,
  }).returning();
  await db.insert(partnerPriceVersions).values({
    contractId: demoContract.id,
    version: "v1",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    pricesJson: DEMO_WHOLESALE,
  });
  const [courierUser] = await db.select().from(users).where(eq(users.phone, "+79990000002")).limit(1);
  const [existingShift] = await db.select().from(courierShifts).where(and(
    eq(courierShifts.organizationId, org.id), eq(courierShifts.courierId, courierUser.id),
  )).limit(1);
  if (!existingShift) {
    await db.insert(courierShifts).values({
      organizationId: org.id, courierId: courierUser.id, state: "active",
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
  // Demo tariff. `unitPriceKopeks` is per 100 g (the `gram_up_to_100` rounding rule), so 9_000
  // means 900 ₽ per kilogram. The figures are demonstrative, not an approved tariff, but they are
  // deliberately in a plausible range: a partner's wholesale is 600 ₽/kg, so a demo price far
  // below that would make every margin, receivable and take-rate figure in the product read as
  // nonsense.
  await db.insert(priceRules).values(DEMO_PRICE_RULES(version.id, {
    wash: wash.id, delicate: delicate.id, ironing: ironing.id, outerwear: outerwear.id,
  }));
  await db.insert(documentVersions).values({
    organizationId: org.id, kind: "offer", version: TERMS,
    contentHash: "demo-offer-hash", bodyText: "Демонстрационная оферта. Условия требуют проверки юристом.",
    publishedAt: new Date(),
  });

  const summary = await demoSummary(db, org.id, {
    buildingId: building1.id, pickupWindowId: pickup1.id, deliveryWindowId: delivery1.id,
    tariffVersionId: version.id, serviceId: wash.id, ironingServiceId: ironing.id, termsVersion: TERMS,
  });
  const book = await seedBookForTenant(db, summary);
  return { ...summary, demoBook: book };
}

/**
 * Seeds the demo book of business on top of the base tenant seed.
 *
 * The base seed creates the tenant, the catalogue and the personas but no orders, so every
 * dashboard reads zero. The book is driven through the real domain services, so the rows it
 * produces are indistinguishable in shape from real rows — and every scenario reuses a stable
 * idempotency key, so a second run replays instead of duplicating.
 */
async function seedBookForTenant(db: DbLike, summary: Awaited<ReturnType<typeof demoSummary>>) {
  const partnerId = summary.partners[0]?.id;
  if (!partnerId) return { orders: 0, customers: 0, protectedOrders: 0, garments: 0, invoices: 0, captures: 0, refunds: 0, claims: 0, partnerInvoices: 0, partnerDisputes: 0, partnerCreditNotes: 0, partnerPayouts: 0 };
  return seedDemoTenantBook(db, {
    organizationId: summary.organizationId,
    buildings: summary.buildings,
    tariffVersionId: summary.tariffVersionId,
    termsVersion: summary.termsVersion,
    serviceId: summary.serviceId,
    shiftId: summary.shiftId,
    partnerId,
  });
}

async function seedBookForExistingTenant(db: DbLike, organizationId: string) {
  await ensureDemoEconomics(db, organizationId);
  const minEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.update(courierShifts).set({
    endsAt: sql`GREATEST(${courierShifts.endsAt}, ${minEndsAt})`,
  }).where(and(
    eq(courierShifts.organizationId, organizationId),
    eq(courierShifts.state, "active"),
  ));
  const summary = await demoSummary(db, organizationId);
  const book = await seedBookForTenant(db, summary);
  return { ...summary, demoBook: book };
}

async function demoSummary(
  db: DbLike,
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
