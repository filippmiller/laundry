import { auditEvents, outboxEvents } from "../db/schema.js";
import type { Tx } from "../db/client.js";
import type { Principal } from "./context.js";

/**
 * The dedupe key of a customer-visible support transition.
 *
 * The thread alone does not name a transition: the same thread can be closed and reopened over
 * and over, and every one of those transitions is a separate event the customer has to hear
 * about. The event id does name it: it is unique per transition, and the outbox copy of that
 * very event carries the very same id, so the direct notification and the outbox copy collapse
 * into one while a later transition gets a key of its own.
 */
export function supportTransitionDedupeKey(
  threadId: string,
  transition: "closed" | "reopened",
  eventId: string,
): string {
  return `support:${threadId}:${transition}:${eventId}`;
}

export async function appendEvent(
  tx: Tx,
  input: {
    principal: Principal;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    reason?: string;
  },
) {
  // The id of the outbox row is the id of the event: a caller that has to name the event in a
  // dedupe key (so that a replay collapses into the first delivery) needs it back.
  const [event] = await tx.insert(outboxEvents).values({
    organizationId: input.principal.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payloadJson: {
      ...input.payload,
      actorId: input.principal.userId,
      requestId: input.principal.requestId,
      occurredAt: new Date().toISOString(),
    },
  }).returning({ id: outboxEvents.id });
  await tx.insert(auditEvents).values({
    organizationId: input.principal.organizationId,
    actorId: input.principal.userId,
    action: input.eventType,
    resourceType: input.aggregateType,
    resourceId: input.aggregateId,
    scopeJson: { partnerId: input.principal.partnerId ?? null, deviceId: input.principal.deviceId ?? null },
    reason: input.reason ?? null,
    requestId: input.principal.requestId,
  });
  return { id: event.id };
}
