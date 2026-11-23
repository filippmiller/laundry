import { and, desc, eq, gt, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { buildings, cities, serviceWindows, services, tariffPlans, tariffVersions } from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { errors } from "../core/errors.js";

export async function listServices(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.partner);
  // A service withdrawn from the catalogue must not be offered any more.
  return db.select().from(services).where(and(
    eq(services.organizationId, principal.organizationId),
    eq(services.active, true),
  ));
}

export async function resolveAddress(db: Db, principal: Principal, buildingId: string) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const [row] = await db.select({
    buildingId: buildings.id,
    address: buildings.address,
    cityId: cities.id,
    city: cities.name,
    timezone: buildings.timezone,
  }).from(buildings)
    .innerJoin(cities, eq(buildings.cityId, cities.id))
    .where(and(eq(buildings.id, buildingId), eq(buildings.organizationId, principal.organizationId)))
    .limit(1);
  if (!row) throw errors.notFound("building");
  return row;
}

export async function listWindows(
  db: Db,
  principal: Principal,
  input: { buildingId: string; kind: "pickup" | "delivery"; from?: Date; to?: Date },
) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const [building] = await db.select({ id: buildings.id }).from(buildings).where(and(
    eq(buildings.id, input.buildingId),
    eq(buildings.organizationId, principal.organizationId),
  )).limit(1);
  if (!building) throw errors.notFound("building");
  const conditions = [
    eq(serviceWindows.organizationId, principal.organizationId),
    eq(serviceWindows.buildingId, input.buildingId),
    eq(serviceWindows.kind, input.kind),
    eq(serviceWindows.status, "open"),
  ];
  if (input.from) conditions.push(gte(serviceWindows.startsAt, input.from));
  if (input.to) conditions.push(lte(serviceWindows.endsAt, input.to));
  return db.select().from(serviceWindows).where(and(...conditions));
}

export async function activeTariff(db: Db, principal: Principal, tariffVersionId?: string, now = new Date()) {
  const conditions = [
    eq(tariffVersions.published, true),
    eq(tariffPlans.organizationId, principal.organizationId),
    lte(tariffVersions.effectiveFrom, now),
    or(isNull(tariffVersions.effectiveTo), gt(tariffVersions.effectiveTo, now)),
  ];
  if (tariffVersionId) conditions.push(eq(tariffVersions.id, tariffVersionId));
  const [version] = await db.select({ version: tariffVersions })
    .from(tariffVersions)
    .innerJoin(tariffPlans, eq(tariffVersions.planId, tariffPlans.id))
    .where(and(...conditions))
    // The newest version that has already taken effect is the current one. Ordering ascending
    // picked the oldest still-published version, so a price increase never reached a quote as
    // long as the previous version had not been closed.
    .orderBy(desc(tariffVersions.effectiveFrom))
    .limit(1);
  if (!version) throw errors.notFound("tariff version");
  return version.version;
}
