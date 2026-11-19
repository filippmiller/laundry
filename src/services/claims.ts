import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  claimDecisions, claimItems, claims, evidenceAssets, evidenceLegalHolds, garments, orders,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

/** Evidence purposes that may legally be attached to a customer claim. */
const CLAIM_EVIDENCE_PURPOSES = new Set(["intake_condition", "delivery_proof", "claim_evidence", "qc"]);

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
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
    replayGuard: async tx => {
      const [order] = await tx.select().from(orders).where(and(
        eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
      )).limit(1);
      if (!order) throw errors.notFound("order");
      if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");
    },
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");

    // Claim items must be garments of this exact order, never another order's inventory.
    if (input.garmentIds?.length) {
      const claimedGarments = await tx.select({ id: garments.id }).from(garments).where(and(
        eq(garments.organizationId, principal.organizationId),
        eq(garments.orderId, order.id),
        inArray(garments.id, input.garmentIds),
      ));
      if (claimedGarments.length !== new Set(input.garmentIds).size) throw errors.notFound("garment");
    }

    // Evidence is bound to the order owner, a verified/held state and a claim-appropriate purpose.
    const evidenceScope = and(
      eq(evidenceAssets.organizationId, principal.organizationId),
      eq(evidenceAssets.ownerType, "order"),
      eq(evidenceAssets.ownerId, order.id),
      inArray(evidenceAssets.status, ["verified", "legal_hold"]),
      inArray(evidenceAssets.purpose, [...CLAIM_EVIDENCE_PURPOSES]),
    );
    const orderEvidence = await tx.select().from(evidenceAssets).where(evidenceScope);
    const evidence = input.evidenceIds?.length
      ? await tx.select().from(evidenceAssets).where(and(
        evidenceScope,
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
      // The `evidence_legal_holds_sync` trigger already keeps the counter and the status in step
      // with the hold rows. Counting it here as well made every hold count twice, so the counter
      // could never come back down.
      await tx.insert(evidenceLegalHolds).values({
        organizationId: principal.organizationId,
        assetId: asset.id,
        claimId: claim.id,
        reason: `claim:${claim.id}`,
        placedBy: principal.userId,
      });
    }
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: claim.id, eventType: "claim.opened",
      payload: { orderId: order.id, claimType: input.claimType, evidenceIds: evidence.map(asset => asset.id) },
    });
    return { claimId: claim.id, orderId: order.id, state: "opened" as const };
  });
}

/** Claim detail for its customer or support staff, with items, decisions and held evidence ids. */
export async function getClaim(db: Db, principal: Principal, claimId: string) {
  assertRole(principal, "customer", ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.dispatcher);
  const [claim] = await db.select().from(claims).where(and(
    eq(claims.id, claimId),
    eq(claims.organizationId, principal.organizationId),
  )).limit(1);
  if (!claim) throw errors.notFound("claim");
  const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(and(
    eq(orders.id, claim.orderId),
    eq(orders.organizationId, principal.organizationId),
  )).limit(1);
  const staff = hasRole(principal, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.dispatcher);
  if (!staff && order?.customerId !== principal.userId) throw errors.notFound("claim");
  const items = await db.select().from(claimItems).where(eq(claimItems.claimId, claim.id));
  const decisions = await db.select().from(claimDecisions).where(eq(claimDecisions.claimId, claim.id));
  const holds = await db.select({
    assetId: evidenceLegalHolds.assetId,
    reason: evidenceLegalHolds.reason,
    createdAt: evidenceLegalHolds.createdAt,
    releasedAt: evidenceLegalHolds.releasedAt,
  }).from(evidenceLegalHolds).where(eq(evidenceLegalHolds.claimId, claim.id));
  return { claim, items, decisions, evidenceHolds: holds };
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
