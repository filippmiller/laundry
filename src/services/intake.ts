import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  claims, containerAssignments, containers, courierDevices, courierShifts, custodyEvents, evidenceAssets,
  garmentEvidence, garments, intakeManifestLines, intakeManifests, notifications, orders, quotes,
  routes, routeStops, scanEvents, seals,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency } from "../core/idempotency.js";
import { canonicalScanHash } from "../core/scan-hash.js";
import { nextState } from "../domain/order-state.js";
import { findSubtype } from "../../shared/garment-taxonomy.js";

export type BagInput = { containerCode: string; sealSerial: string; weightGrams: number };
export type GarmentInput = {
  itemCode: string; category: string; description: string;
  declaredValueKopeks?: number; condition?: Record<string, unknown>; evidenceAssetIds?: string[];
  /**
   * Taxonomy subtype the courier picked with the icon grid. When it is present
   * the server derives the category itself, so a hand-crafted request cannot
   * smuggle an arbitrary category string into the analytics.
   */
  subtypeId?: string;
};
export type IntakeInput = {
  orderId: string;
  mode: "economy_bag" | "protected_items" | "mixed";
  bags: BagInput[];
  items?: GarmentInput[];
  customerConfirmation: boolean;
  courierConfirmation: boolean;
  handoffCode?: string;
  deviceId?: string;
  key: string;
};

export async function recordIntake(db: Db, principal: Principal, input: IntakeInput) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  if (!input.customerConfirmation || !input.courierConfirmation) {
    throw new AppError("EVIDENCE_REQUIRED", "DUAL_CONFIRMATION_REQUIRED");
  }
  if (input.mode === "mixed") {
    if (!input.bags.length || !input.items?.length) {
      throw new AppError("VALIDATION_ERROR", "MIXED_SEPARATION_REQUIRED");
    }
    const bagCodes = new Set(input.bags.map(bag => bag.containerCode.trim()));
    const itemCodes = new Set<string>();
    for (const item of input.items) {
      const code = item.itemCode?.trim();
      if (!code || itemCodes.has(code) || bagCodes.has(code)) {
        throw new AppError("VALIDATION_ERROR", "MIXED_SEPARATION_REQUIRED");
      }
      itemCodes.add(code);
    }
  }
  if (!input.bags.length) throw new AppError("VALIDATION_ERROR", "BAG_REQUIRED");

  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "intake:record",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId),
      eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (order.lifecycleState !== "pickup_assigned") {
      throw new AppError("INVALID_TRANSITION", "ORDER_NOT_READY_FOR_INTAKE", { state: order.lifecycleState });
    }
    const isDispatcher = hasRole(principal, ...ROLE_GROUPS.dispatcher);
    const [stop] = await tx.select().from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, input.orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    )).limit(1);
    if (!stop && !isDispatcher) throw errors.forbidden("courier is not assigned to this stop");
    if (!isDispatcher) {
      const [shiftRow] = await tx.select({ state: courierShifts.state })
        .from(routes)
        .innerJoin(courierShifts, eq(courierShifts.id, routes.shiftId))
        .where(and(
          eq(routes.id, stop!.routeId),
          eq(routes.organizationId, principal.organizationId),
          eq(courierShifts.organizationId, principal.organizationId),
        ))
        .limit(1);
      if (!shiftRow || shiftRow.state !== "active") {
        throw new AppError("FORBIDDEN", "SHIFT_NOT_ACTIVE");
      }
    }

    const [quote] = await tx.select({ snapshotJson: quotes.snapshotJson }).from(quotes).where(and(
      eq(quotes.id, order.quoteId),
      eq(quotes.organizationId, principal.organizationId),
    )).limit(1);
    if (!quote) throw errors.notFound("quote");
    const quoteSnapshot = (quote.snapshotJson ?? {}) as {
      lines?: Array<{ kind?: string; tier?: "economy" | "protected" }>;
    };
    const quotedTiers = new Set(
      (quoteSnapshot.lines ?? [])
        .filter(line => line.kind === "service" && line.tier)
        .map(line => line.tier!),
    );
    if (!quotedTiers.has("protected") && (
      input.mode === "protected_items"
      || input.mode === "mixed"
      || (input.items?.length ?? 0) > 0
    )) {
      throw new AppError("VALIDATION_ERROR", "INTAKE_MODE_EXCEEDS_QUOTED_TIER", {
        mode: input.mode,
        quotedTiers: [...quotedTiers],
      });
    }
    if (input.handoffCode) {
      if (!order.handoffCode || input.handoffCode.trim() !== order.handoffCode) {
        throw new AppError("FORBIDDEN", "HANDOFF_PIN_MISMATCH");
      }
    }

    const serials = input.bags.map(bag => bag.sealSerial);
    const sealRows = await tx.select().from(seals).where(and(
      eq(seals.organizationId, principal.organizationId),
      inArray(seals.serialNumber, serials),
    ));
    const sealBySerial = new Map(sealRows.map(seal => [seal.serialNumber, seal]));
    for (const bag of input.bags) {
      const seal = sealBySerial.get(bag.sealSerial);
      if (!seal || seal.state !== "available") throw new AppError("CUSTODY_CONFLICT", "SEAL_NOT_AVAILABLE", { serial: bag.sealSerial });
      if (!Number.isInteger(bag.weightGrams) || bag.weightGrams < 0) throw new AppError("VALIDATION_ERROR", "INVALID_WEIGHT");
    }

    const manifestHash = hashRequest({
      orderId: input.orderId, mode: input.mode, bags: input.bags, items: input.items ?? [],
    });
    const [manifest] = await tx.insert(intakeManifests).values({
      organizationId: principal.organizationId,
      orderId: input.orderId,
      mode: input.mode,
      count: input.bags.length,
      weightGrams: input.bags.reduce((sum, bag) => sum + bag.weightGrams, 0),
      manifestHash,
      customerConfirmationId: order.customerId,
      courierConfirmationId: principal.userId,
      state: "accepted",
    }).returning();

    for (const bag of input.bags) {
      // `containers` is unique per `(organization_id, code)`: a physical bag outlives the order
      // within its tenant, so an existing one in the same organization is reused.
      let [container] = await tx.select().from(containers)
        .where(and(
          eq(containers.organizationId, principal.organizationId),
          eq(containers.code, bag.containerCode),
        )).limit(1);
      if (!container) {
        [container] = await tx.insert(containers).values({
          organizationId: principal.organizationId, code: bag.containerCode,
        }).returning();
      }
      // A container may have at most one active assignment. A bag that is still out with another
      // order is a custody conflict — the database would refuse the insert with a raw unique
      // violation, which the API reports as an unexplained 500.
      const [activeAssignment] = await tx.select({ id: containerAssignments.id })
        .from(containerAssignments).where(and(
          eq(containerAssignments.containerId, container.id),
          isNull(containerAssignments.unassignedAt),
        )).limit(1);
      if (activeAssignment) {
        throw new AppError("CUSTODY_CONFLICT", "CONTAINER_ALREADY_ASSIGNED", { code: bag.containerCode });
      }
      const seal = sealBySerial.get(bag.sealSerial)!;
      // The seal is claimed conditionally: two couriers reading the same serial must not both
      // end up owning it.
      const claimed = await tx.update(seals).set({ state: "assigned" })
        .where(and(eq(seals.id, seal.id), eq(seals.state, "available")))
        .returning({ id: seals.id });
      if (!claimed.length) {
        throw new AppError("CUSTODY_CONFLICT", "SEAL_NOT_AVAILABLE", { serial: bag.sealSerial });
      }
      await tx.insert(containerAssignments).values({
        organizationId: principal.organizationId,
        containerId: container.id, orderId: input.orderId, sealId: seal.id,
      });
      await tx.insert(intakeManifestLines).values({
        manifestId: manifest.id, description: `bag:${bag.containerCode}`, weightGrams: bag.weightGrams,
      });
    }

    if ((input.mode === "protected_items" || input.mode === "mixed") && !input.items?.length) {
      throw new AppError("EVIDENCE_REQUIRED", "PROTECTED_ITEMS_REQUIRED");
    }
    const createdGarments: Array<{ id: string; itemCode: string }> = [];
    for (const item of input.items ?? []) {
      // The taxonomy is the authority on the category: a picked subtype always
      // wins over whatever string the client sent.
      const subtype = item.subtypeId ? findSubtype(item.subtypeId) : undefined;
      if (item.subtypeId && !subtype) {
        throw new AppError("VALIDATION_ERROR", "UNKNOWN_GARMENT_SUBTYPE", { subtypeId: item.subtypeId });
      }
      const category = subtype?.category ?? item.category;
      const [garment] = await tx.insert(garments).values({
        organizationId: principal.organizationId,
        orderId: input.orderId,
        itemCode: item.itemCode,
        category,
        description: item.description,
        declaredValueKopeks: item.declaredValueKopeks ?? null,
        conditionJson: subtype
          ? { ...(item.condition ?? {}), subtypeId: subtype.id, subtypeLabel: subtype.label }
          : (item.condition ?? {}),
        status: "accepted",
      }).returning();
      for (const evidenceId of item.evidenceAssetIds ?? []) {
        const [asset] = await tx.select({
          id: evidenceAssets.id,
          ownerType: evidenceAssets.ownerType,
          ownerId: evidenceAssets.ownerId,
        }).from(evidenceAssets).where(and(
          eq(evidenceAssets.id, evidenceId),
          eq(evidenceAssets.organizationId, principal.organizationId),
          eq(evidenceAssets.status, "verified"),
          isNull(evidenceAssets.deletedAt),
        )).limit(1);
        if (!asset) throw errors.notFound("evidence asset");
        let belongsToOrder = (asset.ownerType === "order" || asset.ownerType === "garment")
          && asset.ownerId === input.orderId;
        if (!belongsToOrder && asset.ownerType === "garment") {
          const [ownedGarment] = await tx.select({ id: garments.id }).from(garments).where(and(
            eq(garments.id, asset.ownerId),
            eq(garments.organizationId, principal.organizationId),
            eq(garments.orderId, input.orderId),
          )).limit(1);
          belongsToOrder = Boolean(ownedGarment);
        } else if (!belongsToOrder && asset.ownerType === "custody_event") {
          const [ce] = await tx.select({ id: custodyEvents.id }).from(custodyEvents).where(and(
            eq(custodyEvents.id, asset.ownerId),
            eq(custodyEvents.organizationId, principal.organizationId),
            eq(custodyEvents.orderId, input.orderId),
          )).limit(1);
          belongsToOrder = Boolean(ce);
        } else if (!belongsToOrder && asset.ownerType === "claim") {
          const [cl] = await tx.select({ id: claims.id }).from(claims).where(and(
            eq(claims.id, asset.ownerId),
            eq(claims.organizationId, principal.organizationId),
            eq(claims.orderId, input.orderId),
          )).limit(1);
          belongsToOrder = Boolean(cl);
        }
        if (!belongsToOrder) throw errors.notFound("evidence asset");
        await tx.insert(garmentEvidence).values({
          organizationId: principal.organizationId,
          garmentId: garment.id,
          evidenceAssetId: asset.id,
        }).onConflictDoNothing();
      }
      await tx.insert(intakeManifestLines).values({
        manifestId: manifest.id,
        garmentId: garment.id,
        description: `${category}:${item.itemCode}`,
        quantity: 1,
      });
      createdGarments.push({ id: garment.id, itemCode: item.itemCode });
    }

    const to = nextState(order.lifecycleState as "pickup_assigned", "accept_handoff", principal);
    const [advanced] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ version: orders.version });
    // The optimistic lock only protects anything when its result is checked. Ignored, a lost
    // update writes the custody event and the manifest while the order keeps its old state —
    // the goods have moved but the order says they have not.
    if (!advanced) throw errors.version(order.version);

    const [event] = await tx.insert(custodyEvents).values({
      organizationId: principal.organizationId,
      orderId: input.orderId,
      fromParty: "customer",
      toParty: "courier",
      actorId: principal.userId,
      manifestId: manifest.id,
      manifestHash,
    }).returning();

    await tx.insert(notifications).values({
      organizationId: principal.organizationId,
      recipientId: order.customerId,
      orderId: input.orderId,
      channel: "push",
      template: "intake_confirmed",
      payloadJson: { manifestId: manifest.id, manifestHash },
      dedupeKey: `intake:${input.orderId}`,
    }).onConflictDoNothing();

    await appendEvent(tx, {
      principal,
      aggregateType: "order",
      aggregateId: input.orderId,
      eventType: "order.accept_handoff",
      payload: {
        manifestId: manifest.id,
        custodyEventId: event.id,
        bagCount: input.bags.length,
        verificationMethod: input.handoffCode ? "pin_verified" : "dual_confirmation_demo",
      },
    });
    return {
      orderId: input.orderId,
      manifestId: manifest.id,
      manifestHash,
      custodyEventId: event.id,
      garments: createdGarments,
      state: to,
    };
  });
  return { ...result.value, replayed: result.replayed };
}

export type ScanEventInput = {
  clientEventId: string;
  deviceId: string;
  scannedType: "order" | "container" | "seal";
  scannedId: string;
  capturedAt: string;
  context: Record<string, unknown>;
  payloadHash: string;
};

export async function registerCourierDevice(
  db: Db,
  principal: Principal,
  input: { deviceId: string; label?: string },
) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  const [existing] = await db.select().from(courierDevices).where(and(
    eq(courierDevices.id, input.deviceId),
    eq(courierDevices.organizationId, principal.organizationId),
  )).limit(1);
  if (existing) {
    if (existing.courierId !== principal.userId) throw errors.notFound("device");
    return { deviceId: existing.id, state: existing.state };
  }
  await db.insert(courierDevices).values({
    id: input.deviceId,
    organizationId: principal.organizationId,
    courierId: principal.userId,
    label: input.label ?? "courier device",
  });
  return { deviceId: input.deviceId, state: "active" as const };
}

async function scanRejection(
  db: Db,
  principal: Principal,
  event: ScanEventInput,
): Promise<string | undefined> {
  const [device] = await db.select({ id: courierDevices.id }).from(courierDevices).where(and(
    eq(courierDevices.id, event.deviceId),
    eq(courierDevices.organizationId, principal.organizationId),
    eq(courierDevices.courierId, principal.userId),
    eq(courierDevices.state, "active"),
  )).limit(1);
  if (!device) return "DEVICE_NOT_OWNED";
  if (canonicalScanHash(event) !== event.payloadHash) return "PAYLOAD_HASH_MISMATCH";
  if (hasRole(principal, "courier") && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
    const [shift] = await db.select({ id: courierShifts.id }).from(courierShifts).where(and(
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.courierId, principal.userId),
      eq(courierShifts.state, "active"),
    )).limit(1);
    if (!shift) return "NO_ACTIVE_SHIFT";
  }

  if (event.scannedType === "order") {
    const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, event.scannedId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    )).limit(1);
    return stop ? undefined : "ORDER_NOT_ASSIGNED";
  }

  if (event.scannedType === "container") {
    const [row] = await db.select({ orderId: containerAssignments.orderId }).from(containerAssignments)
      .innerJoin(containers, eq(containers.id, containerAssignments.containerId))
      .where(and(
        eq(containerAssignments.organizationId, principal.organizationId),
        eq(containers.organizationId, principal.organizationId),
        eq(containers.code, event.scannedId),
      )).limit(1);
    if (!row) return "CONTAINER_NOT_ASSIGNED";
    const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, row.orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    )).limit(1);
    return stop ? undefined : "CONTAINER_NOT_ASSIGNED";
  }

  const [sealRow] = await db.select({ orderId: containerAssignments.orderId }).from(containerAssignments)
    .innerJoin(seals, eq(seals.id, containerAssignments.sealId))
    .where(and(
      eq(containerAssignments.organizationId, principal.organizationId),
      eq(seals.serialNumber, event.scannedId),
      eq(seals.state, "assigned"),
    )).limit(1);
  if (!sealRow) return "SEAL_NOT_ASSIGNED";
  const [sealStop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
    eq(routeStops.organizationId, principal.organizationId),
    eq(routeStops.orderId, sealRow.orderId),
    eq(routeStops.assignedCourierId, principal.userId),
    inArray(routeStops.state, ["pending", "en_route", "arrived"]),
  )).limit(1);
  return sealStop ? undefined : "SEAL_NOT_ASSIGNED";
}

function rejectedRetryMismatchReason(
  existing: typeof scanEvents.$inferSelect,
  principal: Principal,
  event: ScanEventInput,
): string | undefined {
  if (existing.organizationId !== principal.organizationId || existing.actorId !== principal.userId) {
    return "DEVICE_NOT_OWNED";
  }
  const eventCapturedMs = new Date(event.capturedAt).getTime();
  const capturedAtMatches = !Number.isNaN(eventCapturedMs)
    && existing.capturedAt.toISOString() === new Date(eventCapturedMs).toISOString();
  const storedContext = existing.contextJson && typeof existing.contextJson === "object" && !Array.isArray(existing.contextJson)
    ? (existing.contextJson as Record<string, unknown>)
    : null;
  if (
    existing.payloadHash !== event.payloadHash
    || canonicalScanHash(event) !== event.payloadHash
    || existing.scannedType !== event.scannedType
    || existing.scannedId !== event.scannedId
    || !capturedAtMatches
    || !storedContext
    || canonicalScanHash({ ...event, context: storedContext }) !== event.payloadHash
  ) {
    return "HASH_MISMATCH";
  }
  return undefined;
}

export async function syncScanEvents(db: Db, principal: Principal, events: ScanEventInput[]) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  const accepted: string[] = [];
  const duplicate: string[] = [];
  const rejected: Array<{ clientEventId: string; reason: string }> = [];
  for (const event of events) {
    const [existing] = await db.select().from(scanEvents).where(and(
      eq(scanEvents.deviceId, event.deviceId),
      eq(scanEvents.clientEventId, event.clientEventId),
    )).limit(1);
    if (existing) {
      if (existing.syncStatus === "rejected") {
        // Re-evaluate previously rejected scans (e.g., courier opened shift or registered device since then).
        // Verify payloadHash and all stored canonical fields match so an inconsistent row can never be promoted.
        const reason = rejectedRetryMismatchReason(existing, principal, event)
          ?? await scanRejection(db, principal, event);
        if (reason) {
          rejected.push({ clientEventId: event.clientEventId, reason });
        } else {
          const updated = await db.update(scanEvents)
            .set({ syncStatus: "accepted", receivedAt: new Date() })
            .where(and(
              eq(scanEvents.id, existing.id),
              eq(scanEvents.syncStatus, "rejected"),
            ))
            .returning({ id: scanEvents.id });
          if (updated.length > 0) {
            accepted.push(event.clientEventId);
            await db.update(courierDevices).set({ lastSeenAt: new Date() }).where(and(
              eq(courierDevices.id, event.deviceId),
              eq(courierDevices.organizationId, principal.organizationId),
            ));
          } else {
            duplicate.push(event.clientEventId);
          }
        }
        continue;
      }
      duplicate.push(event.clientEventId);
      continue;
    }
    const reason = await scanRejection(db, principal, event);
    const inserted = await db.insert(scanEvents).values({
      organizationId: principal.organizationId,
      deviceId: event.deviceId,
      clientEventId: event.clientEventId,
      actorId: principal.userId,
      scannedType: event.scannedType,
      scannedId: event.scannedId,
      contextJson: event.context,
      capturedAt: new Date(event.capturedAt),
      payloadHash: event.payloadHash,
      syncStatus: reason ? "rejected" : "accepted",
    }).onConflictDoNothing().returning({ id: scanEvents.id });
    if (!inserted.length) {
      duplicate.push(event.clientEventId);
    } else if (reason) {
      rejected.push({ clientEventId: event.clientEventId, reason });
    } else {
      accepted.push(event.clientEventId);
      await db.update(courierDevices).set({ lastSeenAt: new Date() }).where(and(
        eq(courierDevices.id, event.deviceId),
        eq(courierDevices.organizationId, principal.organizationId),
      ));
    }
  }
  return { accepted, duplicate, rejected };
}
