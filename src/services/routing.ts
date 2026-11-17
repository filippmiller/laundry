import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  buildings, courierShifts, customerAddresses, intakeManifests, orderLines, orders, routes, routeStops, vehicles,
} from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

export type VrptwStopInput = {
  stopId: string;
  orderId: string;
  buildingId: string;
  address: string;
  kind: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  weightGrams: number;
};

export type VrptwOptions = {
  vehicleCapacityGrams?: number;
  depot?: { lat: number; lon: number };
};

export type VrptwResult = {
  orderedStopIds: string[];
  orderedStops: VrptwStopInput[];
  naiveDistanceMeters: number;
  optimizedDistanceMeters: number;
  savedMeters: number;
  consolidatedBuildings: number;
  engine: "builtin_vrptw_2opt" | "vroom";
};

const DEFAULT_DEPOT = { lat: 55.7558, lon: 37.6173 };
const EARTH_RADIUS_METERS = 6_371_000;
const COURIER_SPEED_METERS_PER_MIN = 400; // ~24 km/h urban courier speed
const STOP_SERVICE_MINUTES = 5;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  if (a.lat === b.lat && a.lon === b.lon) return 0;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Deterministic coordinate lookup within the Moscow courtyard grid. */
export function buildingCoords(buildingId: string, address: string): { lat: number; lon: number } {
  const seed = buildingId.trim() || address.trim() || "moscow-default";
  const digest = createHash("sha256").update(seed).digest();
  const u = digest.readUInt32BE(0) / 0x1_0000_0000;
  const v = digest.readUInt32BE(4) / 0x1_0000_0000;
  return {
    lat: 55.65 + u * 0.20,
    lon: 37.45 + v * 0.34,
  };
}

function tourDistanceMeters(coords: Array<{ lat: number; lon: number }>, depot: { lat: number; lon: number }): number {
  if (coords.length === 0) return 0;
  let total = haversineMeters(depot, coords[0]);
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  total += haversineMeters(coords[coords.length - 1], depot);
  return total;
}

type BuildingGroup = {
  key: string;
  coords: { lat: number; lon: number };
  stops: VrptwStopInput[];
  earliestStartMs: number;
  earliestEndMs: number;
};

function groupStopsByBuilding(stops: VrptwStopInput[]): BuildingGroup[] {
  const byKey = new Map<string, VrptwStopInput[]>();
  for (const stop of stops) {
    const key = stop.buildingId || stop.address || stop.stopId;
    const list = byKey.get(key);
    if (list) list.push(stop);
    else byKey.set(key, [stop]);
  }

  const groups: BuildingGroup[] = [];
  for (const [key, groupStops] of byKey.entries()) {
    const sorted = [...groupStops].sort((a, b) => {
      const endA = a.windowEnd ? a.windowEnd.getTime() : Number.POSITIVE_INFINITY;
      const endB = b.windowEnd ? b.windowEnd.getTime() : Number.POSITIVE_INFINITY;
      if (endA !== endB) return endA - endB;
      const startA = a.windowStart ? a.windowStart.getTime() : Number.POSITIVE_INFINITY;
      const startB = b.windowStart ? b.windowStart.getTime() : Number.POSITIVE_INFINITY;
      return startA - startB;
    });
    const first = sorted[0];
    const earliestStartMs = sorted.reduce(
      (min, s) => Math.min(min, s.windowStart ? s.windowStart.getTime() : Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    const earliestEndMs = sorted.reduce(
      (min, s) => Math.min(min, s.windowEnd ? s.windowEnd.getTime() : Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    groups.push({
      key,
      coords: buildingCoords(first.buildingId, first.address),
      stops: sorted,
      earliestStartMs,
      earliestEndMs,
    });
  }
  return groups;
}

function tourCost(groups: BuildingGroup[], depot: { lat: number; lon: number }, initialTimeMs: number, hasTimeWindows: boolean): number {
  if (groups.length === 0) return 0;
  const dist = tourDistanceMeters(groups.map(g => g.coords), depot);
  if (!hasTimeWindows) return dist;

  let penalty = 0;
  let current = depot;
  let currentTimeMs = initialTimeMs;
  for (const group of groups) {
    const legMeters = haversineMeters(current, group.coords);
    const travelMs = (legMeters / COURIER_SPEED_METERS_PER_MIN) * 60_000;
    let arrivalMs = currentTimeMs + travelMs;
    if (Number.isFinite(group.earliestStartMs) && arrivalMs < group.earliestStartMs) {
      arrivalMs = group.earliestStartMs;
    }
    if (Number.isFinite(group.earliestEndMs) && arrivalMs > group.earliestEndMs) {
      const lateMinutes = (arrivalMs - group.earliestEndMs) / 60_000;
      penalty += lateMinutes * 10_000;
    }
    currentTimeMs = arrivalMs + group.stops.length * STOP_SERVICE_MINUTES * 60_000;
    current = group.coords;
  }
  return dist + penalty;
}

function twoOpt(groups: BuildingGroup[], depot: { lat: number; lon: number }, initialTimeMs: number, hasTimeWindows: boolean): BuildingGroup[] {
  if (groups.length < 3) return [...groups];
  let best = [...groups];
  let bestCost = tourCost(best, depot, initialTimeMs, hasTimeWindows);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const candidateCost = tourCost(candidate, depot, initialTimeMs, hasTimeWindows);
        if (candidateCost + 1e-6 < bestCost) {
          best = candidate;
          bestCost = candidateCost;
          improved = true;
        }
      }
    }
  }
  return best;
}

export function solveVrptwRoute(
  stops: VrptwStopInput[],
  options: VrptwOptions = {},
): Omit<VrptwResult, "engine"> & { engine: "builtin_vrptw_2opt" } {
  const depot = options.depot ?? DEFAULT_DEPOT;
  if (options.vehicleCapacityGrams !== undefined && options.vehicleCapacityGrams >= 0) {
    const totalWeightGrams = stops.reduce((sum, stop) => sum + Math.max(0, stop.weightGrams), 0);
    if (totalWeightGrams > options.vehicleCapacityGrams) {
      throw new AppError("CAPACITY_UNAVAILABLE", "VEHICLE_CAPACITY_EXCEEDED", {
        totalWeightGrams,
        vehicleCapacityGrams: options.vehicleCapacityGrams,
      });
    }
  }

  if (stops.length === 0) {
    return {
      orderedStopIds: [],
      orderedStops: [],
      naiveDistanceMeters: 0,
      optimizedDistanceMeters: 0,
      savedMeters: 0,
      consolidatedBuildings: 0,
      engine: "builtin_vrptw_2opt" as const,
    };
  }

  const naiveCoords = stops.map(stop => buildingCoords(stop.buildingId, stop.address));
  const naiveDistanceMeters = Math.round(tourDistanceMeters(naiveCoords, depot));

  const groups = groupStopsByBuilding(stops);
  const consolidatedBuildings = groups.filter(group => group.stops.length > 1).length;

  const finiteStarts = groups.map(g => g.earliestStartMs).filter(Number.isFinite);
  const finiteEnds = groups.map(g => g.earliestEndMs).filter(Number.isFinite);
  const hasTimeWindows = finiteEnds.length > 0;
  const initialTimeMs = finiteStarts.length > 0 ? Math.min(...finiteStarts) : 0;
  const maxFiniteEnd = finiteEnds.length > 0 ? Math.max(...finiteEnds) : 0;

  // Nearest-Neighbor construction with time-window urgency
  const unvisited = [...groups];
  const nnGroups: BuildingGroup[] = [];
  let currentCoords = depot;
  let currentTimeMs = initialTimeMs;

  while (unvisited.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestArrivalMs = currentTimeMs;

    for (let i = 0; i < unvisited.length; i++) {
      const candidate = unvisited[i];
      const distMeters = haversineMeters(currentCoords, candidate.coords);
      const travelMs = (distMeters / COURIER_SPEED_METERS_PER_MIN) * 60_000;
      let arrivalMs = currentTimeMs + travelMs;
      if (Number.isFinite(candidate.earliestStartMs) && arrivalMs < candidate.earliestStartMs) {
        arrivalMs = candidate.earliestStartMs;
      }

      let score = distMeters;
      if (hasTimeWindows) {
        const effectiveEnd = Number.isFinite(candidate.earliestEndMs)
          ? candidate.earliestEndMs
          : maxFiniteEnd + 4 * 3600_000;
        const slackMinutes = (effectiveEnd - arrivalMs) / 60_000;
        const latePenalty = slackMinutes < 0 ? Math.abs(slackMinutes) * 2000 : 0;
        const urgencyMeters = Math.max(0, slackMinutes) * 100;
        score = distMeters + urgencyMeters + latePenalty;
      }

      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
        bestArrivalMs = arrivalMs;
      }
    }

    const [picked] = unvisited.splice(bestIdx, 1);
    nnGroups.push(picked);
    currentCoords = picked.coords;
    currentTimeMs = bestArrivalMs + picked.stops.length * STOP_SERVICE_MINUTES * 60_000;
  }

  const candidateA = twoOpt(nnGroups, depot, initialTimeMs, hasTimeWindows);
  const candidateB = twoOpt(groups, depot, initialTimeMs, hasTimeWindows);
  const bestGroups = tourCost(candidateA, depot, initialTimeMs, hasTimeWindows)
    <= tourCost(candidateB, depot, initialTimeMs, hasTimeWindows)
    ? candidateA
    : candidateB;

  const orderedStops = bestGroups.flatMap(group => group.stops);
  const optimizedDistanceMeters = Math.round(
    tourDistanceMeters(orderedStops.map(stop => buildingCoords(stop.buildingId, stop.address)), depot),
  );
  const savedMeters = Math.max(0, naiveDistanceMeters - optimizedDistanceMeters);

  return {
    orderedStopIds: orderedStops.map(stop => stop.stopId),
    orderedStops,
    naiveDistanceMeters,
    optimizedDistanceMeters,
    savedMeters,
    consolidatedBuildings,
    engine: "builtin_vrptw_2opt" as const,
  };
}

async function tryVroomSolve(
  vroomUrl: string,
  stops: VrptwStopInput[],
  fallback: Omit<VrptwResult, "engine"> & { engine: "builtin_vrptw_2opt" },
  vehicleCapacityGrams?: number,
): Promise<VrptwResult> {
  const depot = DEFAULT_DEPOT;
  const jobs = stops.map((stop, idx) => {
    const coords = buildingCoords(stop.buildingId, stop.address);
    const job: Record<string, unknown> = {
      id: idx + 1,
      location: [coords.lon, coords.lat],
      delivery: [Math.max(0, stop.weightGrams)],
    };
    if (stop.windowStart && stop.windowEnd) {
      job.time_windows = [[
        Math.floor(stop.windowStart.getTime() / 1000),
        Math.floor(stop.windowEnd.getTime() / 1000),
      ]];
    }
    return job;
  });

  const vehicle: Record<string, unknown> = {
    id: 1,
    start: [depot.lon, depot.lat],
    end: [depot.lon, depot.lat],
  };
  if (vehicleCapacityGrams !== undefined && vehicleCapacityGrams > 0) {
    vehicle.capacity = [vehicleCapacityGrams];
  }

  try {
    const res = await fetch(vroomUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vehicles: [vehicle], jobs }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return fallback;
    const data = await res.json() as {
      routes?: Array<{ steps?: Array<{ type?: string; job?: number }>; distance?: number }>;
    };
    const steps = data?.routes?.[0]?.steps?.filter(step => step.type === "job" && typeof step.job === "number") ?? [];
    if (steps.length !== stops.length) return fallback;

    const seen = new Set<number>();
    const orderedStops: VrptwStopInput[] = [];
    for (const step of steps) {
      const idx = step.job! - 1;
      if (idx < 0 || idx >= stops.length || seen.has(idx)) return fallback;
      seen.add(idx);
      orderedStops.push(stops[idx]);
    }
    const vroomDist = typeof data?.routes?.[0]?.distance === "number"
      ? Math.round(data.routes[0].distance)
      : Math.round(tourDistanceMeters(orderedStops.map(s => buildingCoords(s.buildingId, s.address)), depot));

    return {
      orderedStopIds: orderedStops.map(s => s.stopId),
      orderedStops,
      naiveDistanceMeters: fallback.naiveDistanceMeters,
      optimizedDistanceMeters: vroomDist,
      savedMeters: Math.max(0, fallback.naiveDistanceMeters - vroomDist),
      consolidatedBuildings: fallback.consolidatedBuildings,
      engine: "vroom" as const,
    };
  } catch {
    return fallback;
  }
}

export async function optimizeShiftRoutes(
  db: Db,
  principal: Principal,
  input: { shiftId: string; vehicleCapacityGrams?: number; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "route:optimize",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [shift] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.id, input.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    )).limit(1);
    if (!shift) throw errors.notFound("shift");

    let vehicleCapacity = input.vehicleCapacityGrams;
    if (vehicleCapacity === undefined && shift.vehicleId) {
      const [vehicle] = await tx.select({ capacityWeightGrams: vehicles.capacityWeightGrams })
        .from(vehicles).where(and(
          eq(vehicles.id, shift.vehicleId),
          eq(vehicles.organizationId, principal.organizationId),
        )).limit(1);
      if (vehicle && vehicle.capacityWeightGrams > 0) {
        vehicleCapacity = vehicle.capacityWeightGrams;
      }
    }

    const shiftRoutes = await tx.select({ id: routes.id }).from(routes).where(and(
      eq(routes.organizationId, principal.organizationId),
      eq(routes.shiftId, shift.id),
    ));
    if (shiftRoutes.length === 0) {
      return {
        shiftId: shift.id,
        orderedStopIds: [] as string[],
        orderedStops: [] as VrptwStopInput[],
        naiveDistanceMeters: 0,
        optimizedDistanceMeters: 0,
        savedMeters: 0,
        consolidatedBuildings: 0,
        engine: "builtin_vrptw_2opt" as const,
        updatedStops: 0,
        updatedRoutes: 0,
      };
    }

    const routeIds = shiftRoutes.map(r => r.id);
    const allRouteStopRows = await tx.select({
      stopId: routeStops.id,
      routeId: routeStops.routeId,
      orderId: routeStops.orderId,
      buildingId: sql<string>`COALESCE(${routeStops.buildingId}, ${customerAddresses.buildingId})`,
      address: buildings.address,
      kind: routeStops.kind,
      state: routeStops.state,
      sequence: routeStops.sequence,
      windowStart: routeStops.windowStart,
      windowEnd: routeStops.windowEnd,
    }).from(routeStops)
      .innerJoin(routes, eq(routes.id, routeStops.routeId))
      .innerJoin(orders, eq(orders.id, routeStops.orderId))
      .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
      .innerJoin(buildings, eq(buildings.id, sql`COALESCE(${routeStops.buildingId}, ${customerAddresses.buildingId})`))
      .where(and(
        eq(routeStops.organizationId, principal.organizationId),
        inArray(routeStops.routeId, routeIds),
      ))
      .orderBy(asc(routeStops.sequence), asc(routeStops.id));

    const activeStopRows = allRouteStopRows.filter(row => row.state === "pending" || row.state === "en_route");
    if (activeStopRows.length === 0) {
      return {
        shiftId: shift.id,
        orderedStopIds: [] as string[],
        orderedStops: [] as VrptwStopInput[],
        naiveDistanceMeters: 0,
        optimizedDistanceMeters: 0,
        savedMeters: 0,
        consolidatedBuildings: 0,
        engine: "builtin_vrptw_2opt" as const,
        updatedStops: 0,
        updatedRoutes: 0,
      };
    }

    const orderIds = [...new Set(activeStopRows.map(row => row.orderId))];
    const [manifestRows, lineRows] = await Promise.all([
      tx.select({ orderId: intakeManifests.orderId, weightGrams: intakeManifests.weightGrams })
        .from(intakeManifests)
        .where(and(
          eq(intakeManifests.organizationId, principal.organizationId),
          inArray(intakeManifests.orderId, orderIds),
        )),
      tx.select({
        orderId: orderLines.orderId,
        quotedQuantity: orderLines.quotedQuantity,
        unit: orderLines.unit,
      }).from(orderLines)
        .where(inArray(orderLines.orderId, orderIds)),
    ]);

    const manifestWeightByOrder = new Map<string, number>();
    for (const row of manifestRows) {
      manifestWeightByOrder.set(row.orderId, (manifestWeightByOrder.get(row.orderId) ?? 0) + row.weightGrams);
    }
    const estimatedWeightByOrder = new Map<string, number>();
    for (const row of lineRows) {
      const grams = row.unit === "gram" ? row.quotedQuantity : row.quotedQuantity * 500;
      estimatedWeightByOrder.set(row.orderId, (estimatedWeightByOrder.get(row.orderId) ?? 0) + grams);
    }

    const solverStops: VrptwStopInput[] = activeStopRows.map(row => {
      const manifestWeight = manifestWeightByOrder.get(row.orderId) ?? 0;
      const estimatedWeight = estimatedWeightByOrder.get(row.orderId) ?? 0;
      return {
        stopId: row.stopId,
        orderId: row.orderId,
        buildingId: row.buildingId,
        address: row.address,
        kind: row.kind,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        weightGrams: manifestWeight > 0 ? manifestWeight : estimatedWeight,
      };
    });

    const fallback = solveVrptwRoute(solverStops, { vehicleCapacityGrams: vehicleCapacity });
    const vroomUrl = process.env.VROOM_URL?.trim();
    const solved: VrptwResult = vroomUrl
      ? await tryVroomSolve(vroomUrl, solverStops, fallback, vehicleCapacity)
      : fallback;

    // Safely re-sequence stops avoiding unique index collisions on (routeId, sequence)
    const maxExistingSeq = allRouteStopRows.reduce((max, row) => Math.max(max, row.sequence), 0);
    const offsetBase = Math.max(10_000, maxExistingSeq + 10_000);
    const activeStopIds = activeStopRows.map(row => row.stopId);
    const stopRouteById = new Map(activeStopRows.map(row => [row.stopId, row.routeId]));

    const occupiedByRoute = new Map<string, Set<number>>();
    for (const row of allRouteStopRows) {
      if (row.state !== "pending" && row.state !== "en_route") {
        let set = occupiedByRoute.get(row.routeId);
        if (!set) {
          set = new Set<number>();
          occupiedByRoute.set(row.routeId, set);
        }
        set.add(row.sequence);
      }
    }

    // Step 1: shift all target stops above any existing sequence on all affected routes
    await tx.update(routeStops).set({
      sequence: sql`${routeStops.sequence} + ${offsetBase}`,
    }).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      inArray(routeStops.id, activeStopIds),
    ));

    // Step 2: write final 1..N sequence in optimized order
    for (let idx = 0; idx < solved.orderedStopIds.length; idx++) {
      const stopId = solved.orderedStopIds[idx];
      const routeId = stopRouteById.get(stopId)!;
      let occupied = occupiedByRoute.get(routeId);
      if (!occupied) {
        occupied = new Set<number>();
        occupiedByRoute.set(routeId, occupied);
      }
      let finalSeq = idx + 1;
      while (occupied.has(finalSeq)) {
        finalSeq += 1;
      }
      occupied.add(finalSeq);
      await tx.update(routeStops).set({
        sequence: finalSeq,
        version: sql`${routeStops.version} + 1`,
      }).where(and(
        eq(routeStops.id, stopId),
        eq(routeStops.organizationId, principal.organizationId),
      ));
    }

    const touchedRouteIds = [...new Set(activeStopRows.map(row => row.routeId))];
    await tx.update(routes).set({ optimizedBy: solved.engine }).where(and(
      eq(routes.organizationId, principal.organizationId),
      inArray(routes.id, touchedRouteIds),
    ));

    await appendEvent(tx, {
      principal,
      aggregateType: "route",
      aggregateId: shift.id,
      eventType: "route.optimized",
      payload: {
        shiftId: shift.id,
        routeIds: touchedRouteIds,
        orderedStopIds: solved.orderedStopIds,
        naiveDistanceMeters: solved.naiveDistanceMeters,
        optimizedDistanceMeters: solved.optimizedDistanceMeters,
        savedMeters: solved.savedMeters,
        consolidatedBuildings: solved.consolidatedBuildings,
        engine: solved.engine,
      },
    });

    return {
      shiftId: shift.id,
      orderedStopIds: solved.orderedStopIds,
      orderedStops: solved.orderedStops,
      naiveDistanceMeters: solved.naiveDistanceMeters,
      optimizedDistanceMeters: solved.optimizedDistanceMeters,
      savedMeters: solved.savedMeters,
      consolidatedBuildings: solved.consolidatedBuildings,
      engine: solved.engine,
      updatedStops: solved.orderedStops.length,
      updatedRoutes: touchedRouteIds.length,
    };
  });
}
