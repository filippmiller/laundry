import { auditEvents, outboxEvents } from "../db/schema.js";
import type { Tx } from "../db/client.js";
import type { Principal } from "./context.js";

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
  await tx.insert(outboxEvents).values({
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
  });
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
}
