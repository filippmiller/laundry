import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  claimDecisions, claimItems, claims, evidenceAssets, evidenceLegalHolds, orders,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

export async function openClaim(
  db: Db,
  principal: Principal,
  input: {
    orderId: string; claimType: string; description: string;
    garmentIds?: string[]; evidenceIds?: string[]; key: string;
  },
) {
  assertRole(principal, "customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "claim:open", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");

    const orderEvidence = await tx.select().from(evidenceAssets).where(and(
      eq(evidenceAssets.organizationId, principal.organizationId),
      eq(evidenceAssets.ownerId, order.id),
      or(eq(evidenceAssets.status, "verified"), eq(evidenceAssets.status, "legal_hold")),
    ));
    const evidence = input.evidenceIds?.length
      ? await tx.select().from(evidenceAssets).where(and(
        eq(evidenceAssets.organizationId, principal.organizationId),
        inArray(evidenceAssets.id, input.evidenceIds),
      ))
      : orderEvidence;
    if (input.evidenceIds?.length && evidence.length !== new Set(input.evidenceIds).size) {
      throw errors.notFound("evidence asset");
    }

    const [claim] = await tx.insert(claims).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      openedBy: principal.userId,
      claimType: input.claimType,
      description: input.description,
      state: "opened",
      dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning();
    for (const garmentId of input.garmentIds ?? []) {
      await tx.insert(claimItems).values({ claimId: claim.id, garmentId, issue: input.claimType });
    }
    for (const asset of evidence) {
      await tx.insert(evidenceLegalHolds).values({
        organizationId: principal.organizationId,
        assetId: asset.id,
        claimId: claim.id,
        reason: `claim:${claim.id}`,
        placedBy: principal.userId,
      });
      await tx.update(evidenceAssets).set({ status: "legal_hold" })
        .where(eq(evidenceAssets.id, asset.id));
    }
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: claim.id, eventType: "claim.opened",
      payload: { orderId: order.id, claimType: input.claimType, evidenceIds: evidence.map(asset => asset.id) },
    });
    return { claimId: claim.id, orderId: order.id, state: "opened" as const };
  });
}

export async function decideClaim(
  db: Db,
  principal: Principal,
  input: { claimId: string; outcome: "resolved" | "denied_with_reason"; rationale: string; key: string },
) {
  assertRole(principal, "claims_approver", "platform_admin");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "claim:decision", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [claim] = await tx.select().from(claims).where(and(
      eq(claims.id, input.claimId), eq(claims.organizationId, principal.organizationId),
    )).limit(1);
    if (!claim) throw errors.notFound("claim");
    if (!["opened", "triage", "investigating", "decision_pending", "escalated", "reopened"].includes(claim.state)) {
      throw new AppError("CONFLICT_VERSION", "CLAIM_NOT_DECIDABLE", { state: claim.state });
    }
    if (input.rationale.trim().length < 10) throw new AppError("VALIDATION_ERROR", "RATIONALE_REQUIRED");
    await tx.insert(claimDecisions).values({
      claimId: claim.id,
      version: claim.version + 1,
      outcome: input.outcome,
      rationale: input.rationale,
      approvedBy: principal.userId,
    });
    await tx.update(claims).set({ state: input.outcome, version: claim.version + 1 })
      .where(and(eq(claims.id, claim.id), eq(claims.version, claim.version)));
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: claim.id, eventType: "claim.decided",
      payload: { outcome: input.outcome, previousVersion: claim.version }, reason: input.rationale,
    });
    return { claimId: claim.id, state: input.outcome, version: claim.version + 1 };
  });
}

export async function reopenClaim(db: Db, principal: Principal, input: { claimId: string; reason: string; key: string }) {
  assertRole(principal, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "claim:reopen", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [claim] = await tx.select().from(claims).where(and(
      eq(claims.id, input.claimId), eq(claims.organizationId, principal.organizationId),
    )).limit(1);
    if (!claim) throw errors.notFound("claim");
    if (!["resolved", "denied_with_reason"].includes(claim.state)) throw errors.transition(claim.state, "reopen");
    await tx.update(claims).set({ state: "reopened", version: claim.version + 1 })
      .where(and(eq(claims.id, claim.id), eq(claims.version, claim.version)));
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: claim.id, eventType: "claim.reopened",
      payload: { previousState: claim.state }, reason: input.reason,
    });
    return { claimId: claim.id, state: "reopened" as const, version: claim.version + 1 };
  });
}
