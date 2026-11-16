import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  containerAssignments, containers, courierDevices, custodyEvents, evidenceAssets, garments,
  intakeManifestLines, intakeManifests, notifications, routeStops, seals, scanEvents, orders,
} from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency } from "../core/idempotency.js";
import { canonicalScanHash } from "../core/scan-hash.js";
import { nextState } from "../domain/order-state.js";

export type BagInput = { containerCode: string; sealSerial: string; weightGrams: number };
export type GarmentInput = {
  itemCode: string; category: string; description: string;
  declaredValueKopeks?: number; condition?: Record<string, unknown>; evidenceAssetIds?: string[];
};
export type IntakeInput = {
  orderId: string;
  mode: "economy_bag" | "protected_items" | "mixed";
  bags: BagInput[];
  items?: GarmentInput[];
  customerConfirmation: boolean;
  courierConfirmation: boolean;
  deviceId?: string;
  key: string;
};

export async function recordIntake(db: Db, principal: Principal, input: IntakeInput) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  if (!input.customerConfirmation || !input.courierConfirmation) {
    throw new AppError("EVIDENCE_REQUIRED", "DUAL_CONFIRMATION_REQUIRED");
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
    const [stop] = await tx.select().from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, input.orderId),
      eq(routeStops.assignedCourierId, principal.userId),
    )).limit(1);
    if (!stop) throw errors.forbidden("courier is not assigned to this stop");

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
      const [container] = await tx.insert(containers).values({
        organizationId: principal.organizationId, code: bag.containerCode,
      }).returning();
      const seal = sealBySerial.get(bag.sealSerial)!;
      await tx.update(seals).set({ state: "assigned" }).where(eq(seals.id, seal.id));
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
      const [garment] = await tx.insert(garments).values({
        organizationId: principal.organizationId,
        orderId: input.orderId,
        itemCode: item.itemCode,
        category: item.category,
        description: item.description,
        declaredValueKopeks: item.declaredValueKopeks ?? null,
        conditionJson: item.condition ?? {},
        status: "accepted",
      }).returning();
      for (const evidenceId of item.evidenceAssetIds ?? []) {
        const [asset] = await tx.select({ id: evidenceAssets.id }).from(evidenceAssets).where(and(
          eq(evidenceAssets.id, evidenceId),
          eq(evidenceAssets.organizationId, principal.organizationId),
          eq(evidenceAssets.status, "verified"),
        )).limit(1);
        if (!asset) throw errors.notFound("evidence asset");
      }
      await tx.insert(intakeManifestLines).values({
        manifestId: manifest.id,
        garmentId: garment.id,
        description: `${item.category}:${item.itemCode}`,
        quantity: 1,
      });
      createdGarments.push({ id: garment.id, itemCode: item.itemCode });
    }

    const to = nextState(order.lifecycleState as "pickup_assigned", "accept_handoff", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));

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
      payload: { manifestId: manifest.id, custodyEventId: event.id, bagCount: input.bags.length },
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

  if (event.scannedType === "order") {
    const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, event.scannedId),
      eq(routeStops.assignedCourierId, principal.userId),
    )).limit(1);
    return stop ? undefined : "ORDER_NOT_ASSIGNED";
  }

  if (event.scannedType === "container") {
    const [row] = await db.select({ orderId: containerAssignments.orderId }).from(containerAssignments)
      .innerJoin(containers, eq(containers.id, containerAssignments.containerId))
      .where(and(
        eq(containerAssignments.organizationId, principal.organizationId),
        eq(containers.code, event.scannedId),
      )).limit(1);
    if (!row) return "CONTAINER_NOT_ASSIGNED";
    const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, row.orderId),
      eq(routeStops.assignedCourierId, principal.userId),
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
  )).limit(1);
  return sealStop ? undefined : "SEAL_NOT_ASSIGNED";
}

export async function syncScanEvents(db: Db, principal: Principal, events: ScanEventInput[]) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  const accepted: string[] = [];
  const duplicate: string[] = [];
  const rejected: Array<{ clientEventId: string; reason: string }> = [];
  for (const event of events) {
    const [device] = await db.select().from(scanEvents).where(and(
      eq(scanEvents.deviceId, event.deviceId),
      eq(scanEvents.clientEventId, event.clientEventId),
    )).limit(1);
    if (device) {
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
