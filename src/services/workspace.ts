import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  claims, compensations, courierShifts, evidenceAssets, evidenceAccessEvents, orders, outboxEvents,
  sessions, supportThreads,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const SUPPORT_ROLES = [...ROLE_GROUPS.support, ...ROLE_GROUPS.admin] as const;
const STAFF = ["dispatcher", "platform_finance", "claims_approver", "customer_support", "platform_admin"] as const;

/** Active sessions of the signed-in principal; the current one is flagged, not hidden. */
export async function listMySessions(db: Db, principal: Principal) {
  return db.select({
    id: sessions.id,
    createdAt: sessions.createdAt,
    expiresAt: sessions.expiresAt,
    revoked: sql<boolean>`(${sessions.revokedAt} IS NOT NULL)`,
  }).from(sessions)
    .where(and(
      eq(sessions.organizationId, principal.organizationId),
      eq(sessions.userId, principal.userId),
      gt(sessions.expiresAt, new Date()),
      isNull(sessions.revokedAt),
    ))
    .orderBy(desc(sessions.createdAt))
    .limit(50)
    .then(rows => rows.map(row => ({ ...row, current: row.id === principal.sessionId })));
}

/** A user may revoke their own sessions only; admins keep the cross-member route. */
export async function revokeOwnSession(
  db: Db,
  principal: Principal,
  input: { sessionId: string; key: string },
) {
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "sessions:revoke-own", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [session] = await tx.select({ id: sessions.id, userId: sessions.userId, revokedAt: sessions.revokedAt })
      .from(sessions).where(and(
        eq(sessions.id, input.sessionId),
        eq(sessions.organizationId, principal.organizationId),
      )).limit(1);
    if (!session || session.userId !== principal.userId) throw errors.notFound("session");
    if (session.revokedAt) return { sessionId: session.id, revoked: true as const, alreadyRevoked: true as const };
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));
    return { sessionId: session.id, revoked: true as const, replayed: false as const };
  });
}

/**
 * Read-only counts for the ops console. Every number is derivable from live rows; nothing is
 * cached, nothing is mutated, and every role in the ops group sees the same projection.
 */
export async function opsMetrics(db: Db, principal: Principal) {
  assertRole(principal, ...STAFF, "courier", "laundry_operator", "security_auditor");
  const org = principal.organizationId;
  const [ordersByState, openClaims, openThreads, captured, pendingOutbox, activeShifts] =
    await Promise.all([
      db.select({ state: orders.lifecycleState, count: sql<number>`count(*)::int` })
        .from(orders).where(eq(orders.organizationId, org)).groupBy(orders.lifecycleState),
      db.select({ count: sql<number>`count(*)::int` }).from(claims).where(and(
        eq(claims.organizationId, org),
        inArray(claims.state, ["opened", "triage", "investigating", "decision_pending", "reopened"]),
      )),
      db.select({ count: sql<number>`count(*)::int` }).from(supportThreads).where(and(
        eq(supportThreads.organizationId, org), eq(supportThreads.state, "open"),
      )),
      db.execute(sql`
        SELECT COALESCE(SUM(amount_kopeks), 0)::bigint AS total FROM payment_intents
        WHERE organization_id = ${org} AND state IN ('captured', 'partially_refunded', 'refunded')
      `),
      db.select({ count: sql<number>`count(*)::int` }).from(outboxEvents).where(and(
        eq(outboxEvents.organizationId, org), eq(outboxEvents.state, "pending"),
      )),
      db.select({ count: sql<number>`count(*)::int` }).from(courierShifts).where(and(
        eq(courierShifts.organizationId, org), inArray(courierShifts.state, ["planned", "active"]),
      )),
    ]);
  return {
    ordersByState: Object.fromEntries(ordersByState.map(row => [row.state, row.count])),
    openClaims: openClaims[0]?.count ?? 0,
    openThreads: openThreads[0]?.count ?? 0,
    capturedKopeks: Number((captured.rows as unknown as Array<{ total: string }>)[0]?.total ?? 0),
    pendingOutbox: pendingOutbox[0]?.count ?? 0,
    activeShifts: activeShifts[0]?.count ?? 0,
  };
}

/**
 * Evidence registration without file storage: the caller registers the object key and hash of a
 * photo that already lives in object storage; the platform records who registered what for whom.
 */
export async function registerEvidence(
  db: Db,
  principal: Principal,
  input: {
    ownerType: "order" | "claim" | "custody_event"; ownerId: string;
    objectKey: string; sha256: string; purpose: string; mimeType?: string; sizeBytes?: number; key: string;
  },
) {
  assertRole(principal, "customer", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new AppError("VALIDATION_ERROR", "SHA256_FORMAT_INVALID");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "evidence:register", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    if (input.ownerType === "order") {
      const [order] = await tx.select({ customerId: orders.customerId }).from(orders).where(and(
        eq(orders.id, input.ownerId), eq(orders.organizationId, principal.organizationId),
      )).limit(1);
      if (!order) throw errors.notFound("order");
      const staff = hasRole(principal, ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
      if (!staff && order.customerId !== principal.userId) throw errors.notFound("order");
    }
    const [asset] = await tx.insert(evidenceAssets).values({
      organizationId: principal.organizationId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      sha256: input.sha256,
      purpose: input.purpose,
      mimeType: input.mimeType ?? "image/jpeg",
      sizeBytes: input.sizeBytes ?? 0,
      status: "pending_upload",
      createdBy: principal.userId,
    }).returning({ id: evidenceAssets.id });
    return { evidenceId: asset.id, status: "pending_upload" as const };
  });
}

export async function listEvidence(db: Db, principal: Principal, ownerType: string, ownerId: string) {
  assertRole(principal, "customer", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  if (ownerType === "order") {
    const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(and(
      eq(orders.id, ownerId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    const staff = hasRole(principal, ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
    if (!staff && order.customerId !== principal.userId) throw errors.notFound("order");
  }
  const rows = await db.select({
    id: evidenceAssets.id,
    objectKey: evidenceAssets.objectKey,
    sha256: evidenceAssets.sha256,
    purpose: evidenceAssets.purpose,
    mimeType: evidenceAssets.mimeType,
    sizeBytes: evidenceAssets.sizeBytes,
    status: evidenceAssets.status,
    createdAt: evidenceAssets.capturedAt,
  }).from(evidenceAssets).where(and(
    eq(evidenceAssets.organizationId, principal.organizationId),
    eq(evidenceAssets.ownerType, ownerType),
    eq(evidenceAssets.ownerId, ownerId),
  )).orderBy(desc(evidenceAssets.capturedAt));
  // Reading evidence is itself auditable: every list access is logged.
  if (rows.length) {
    await db.insert(evidenceAccessEvents).values(
      rows.map(row => ({ assetId: row.id, actorId: principal.userId, purpose: "owner_listing" })),
    );
  }
  return rows;
}

/**
 * Compensation lifecycle: support proposes an amount on a decided claim, finance approves or
 * denies. Approval does not move money — the payout stays an explicit finance action, only the
 * approval is recorded.
 */
export async function proposeCompensation(
  db: Db,
  principal: Principal,
  input: { claimId: string; amountKopeks: number; key: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  if (!Number.isInteger(input.amountKopeks) || input.amountKopeks <= 0) {
    throw new AppError("VALIDATION_ERROR", "AMOUNT_INVALID");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "compensation:propose", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [claim] = await tx.select({ id: claims.id, state: claims.state }).from(claims).where(and(
      eq(claims.id, input.claimId), eq(claims.organizationId, principal.organizationId),
    )).limit(1);
    if (!claim) throw errors.notFound("claim");
    if (!["resolved", "decision_pending", "escalated"].includes(claim.state)) {
      throw new AppError("VALIDATION_ERROR", "CLAIM_NOT_DECIDABLE", { state: claim.state });
    }
    const [compensation] = await tx.insert(compensations).values({
      organizationId: principal.organizationId,
      claimId: claim.id,
      amountKopeks: input.amountKopeks,
      state: "proposed",
    }).returning();
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: claim.id,
      eventType: "claim.compensation_proposed", payload: { compensationId: compensation.id, amountKopeks: input.amountKopeks },
    });
    return { compensationId: compensation.id, state: "proposed" as const };
  });
}

export async function decideCompensation(
  db: Db,
  principal: Principal,
  input: { compensationId: string; approve: boolean; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.finance);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "compensation:decide", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [compensation] = await tx.select().from(compensations).where(and(
      eq(compensations.id, input.compensationId),
      eq(compensations.organizationId, principal.organizationId),
    )).limit(1);
    if (!compensation) throw errors.notFound("compensation");
    if (compensation.state !== "proposed") {
      return { compensationId: compensation.id, state: compensation.state, alreadyDecided: true as const };
    }
    const state = input.approve ? "approved" : "denied";
    await tx.update(compensations).set({ state, approvedBy: principal.userId })
      .where(eq(compensations.id, compensation.id));
    await appendEvent(tx, {
      principal, aggregateType: "claim", aggregateId: compensation.claimId,
      eventType: `claim.compensation_${state}`, payload: { compensationId: compensation.id, amountKopeks: compensation.amountKopeks },
    });
    return { compensationId: compensation.id, state, replayed: false as const };
  });
}

/** Support order search: exact public number or exact customer phone, scoped to the tenant. */
export async function searchOrders(db: Db, principal: Principal, query: string) {
  assertRole(principal, ...SUPPORT_ROLES, ...ROLE_GROUPS.dispatcher);
  const trimmed = query.trim();
  if (trimmed.length < 4) throw new AppError("VALIDATION_ERROR", "QUERY_TOO_SHORT");
  const rows = await db.select({
    id: orders.id,
    publicNumber: orders.publicNumber,
    lifecycleState: orders.lifecycleState,
    createdAt: orders.createdAt,
  }).from(orders).where(and(
    eq(orders.organizationId, principal.organizationId),
    or(
      eq(orders.publicNumber, trimmed.toUpperCase()),
      sql`customer_id IN (SELECT id FROM users WHERE phone = ${trimmed})`,
    ),
  )).orderBy(desc(orders.createdAt)).limit(20);
  return rows;
}
