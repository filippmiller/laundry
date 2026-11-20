import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  buildings, claims, compensations, courierShifts, custodyEvents, customerAddresses,
  evidenceAssets, evidenceAccessEvents, evidenceLegalHolds,
  garmentEvidence, garments, notifications, orders, outboxEvents, reviews, routeStops, sessions, supportThreads, users,
} from "../db/schema.js";
import { assertRole, authorize, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
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
  assertRole(principal, ...STAFF, "security_auditor");
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

export const ALLOWED_EVIDENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "video/mp4",
]);
export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024; // 15 MB
const SERVABLE_EVIDENCE_STATES = new Set(["verified", "retained", "legal_hold"]);
const EVIDENCE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function evidenceStorageRoot(): string {
  return resolve(process.env.EVIDENCE_STORAGE_DIR ?? resolve(process.cwd(), ".evidence-storage"));
}

function evidenceFilePath(organizationId: string, assetId: string): { dir: string; filePath: string } {
  if (!EVIDENCE_UUID_RE.test(organizationId) || !EVIDENCE_UUID_RE.test(assetId)) {
    throw new AppError("VALIDATION_ERROR", "EVIDENCE_ID_INVALID");
  }
  const root = evidenceStorageRoot();
  const dir = resolve(root, organizationId);
  const filePath = resolve(dir, `${assetId}.bin`);
  if (!dir.startsWith(root + sep) || !filePath.startsWith(dir + sep)) {
    throw new AppError("VALIDATION_ERROR", "EVIDENCE_PATH_INVALID");
  }
  return { dir, filePath };
}

async function writeEvidenceBytes(organizationId: string, assetId: string, bytes: Buffer): Promise<void> {
  const { dir, filePath } = evidenceFilePath(organizationId, assetId);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

async function readEvidenceBytes(organizationId: string, assetId: string): Promise<Buffer> {
  const { filePath } = evidenceFilePath(organizationId, assetId);
  try {
    return await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw errors.notFound("evidence");
    }
    throw err;
  }
}

type EvidenceOrderScope = { customerId: string; assignedPartnerId: string | null };

/** Tenant-wide entitlement: support, admin and dispatch staff of the principal's own tenant. */
function isEvidenceStaff(principal: Principal) {
  return hasRole(principal, ...SUPPORT_ROLES, ...ROLE_GROUPS.dispatcher);
}

/** A partner is entitled to the orders custody was assigned to them — never to the whole tenant. */
function isEvidencePartner(principal: Principal) {
  return hasRole(principal, ...ROLE_GROUPS.partner);
}

async function loadScopedOrder(db: Db, principal: Principal, orderId: string): Promise<EvidenceOrderScope | undefined> {
  const [order] = await db.select({
    customerId: orders.customerId,
    assignedPartnerId: orders.assignedPartnerId,
  }).from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.organizationId, principal.organizationId),
  )).limit(1);
  return order;
}

/** Ownership of an order: its customer, the tenant's staff, or the partner custody was assigned to. */
function entitledToOrder(principal: Principal, order: EvidenceOrderScope | undefined): boolean {
  if (!order) return false;
  if (isEvidenceStaff(principal)) return true;
  if (hasRole(principal, "customer") && order.customerId === principal.userId) return true;
  if (isEvidencePartner(principal) && principal.partnerId && order.assignedPartnerId === principal.partnerId) return true;
  return false;
}

/**
 * Resolves the ownership rule of an evidence owner for every owner type. Deny by default: an owner
 * type without a resolved rule, an object outside the principal's tenant, and a principal without a
 * matching entitlement are all refused.
 */
async function isAssignedCourierForOrder(db: Db, principal: Principal, orderId: string): Promise<boolean> {
  if (!hasRole(principal, "courier")) return false;
  const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
    eq(routeStops.organizationId, principal.organizationId),
    eq(routeStops.orderId, orderId),
    eq(routeStops.assignedCourierId, principal.userId),
    inArray(routeStops.state, ["pending", "en_route", "arrived"]),
  )).limit(1);
  return Boolean(stop);
}

async function resolveEvidenceOwnership(
  db: Db,
  principal: Principal,
  ownerType: string,
  ownerId: string,
): Promise<boolean> {
  if (ownerType === "order") {
    const order = await loadScopedOrder(db, principal, ownerId);
    if (entitledToOrder(principal, order)) return true;
    if (order && await isAssignedCourierForOrder(db, principal, ownerId)) return true;
    return false;
  }
  if (ownerType === "claim") {
    const [claim] = await db.select({ openedBy: claims.openedBy, orderId: claims.orderId }).from(claims).where(and(
      eq(claims.id, ownerId),
      eq(claims.organizationId, principal.organizationId),
    )).limit(1);
    if (!claim) return false;
    if (isEvidenceStaff(principal)) return true;
    const order = await loadScopedOrder(db, principal, claim.orderId);
    // A customer sees the evidence of a claim they opened, or of a claim on their own order.
    if (hasRole(principal, "customer")
      && (claim.openedBy === principal.userId || order?.customerId === principal.userId)) {
      return true;
    }
    return entitledToOrder(principal, order);
  }
  if (ownerType === "custody_event") {
    const [event] = await db.select({ orderId: custodyEvents.orderId }).from(custodyEvents).where(and(
      eq(custodyEvents.id, ownerId),
      eq(custodyEvents.organizationId, principal.organizationId),
    )).limit(1);
    if (!event) return false;
    if (isEvidenceStaff(principal)) return true;
    return entitledToOrder(principal, await loadScopedOrder(db, principal, event.orderId));
  }
  return false;
}

/**
 * Object-scoped authorization for a single evidence asset: the tenant must match and the owner
 * object must belong to the principal. The uploader gains no extra right — access follows the
 * owner object, never the person who happened to upload the file.
 */
async function authorizeEvidenceOwner(
  db: Db,
  principal: Principal,
  asset: { id: string; organizationId: string; ownerType: string; ownerId: string },
) {
  authorize(principal, {
    resource: "evidence",
    action: "read",
    organizationId: asset.organizationId,
    resourceId: asset.id,
  });
  const entitled = await resolveEvidenceOwnership(db, principal, asset.ownerType, asset.ownerId);
  authorize(principal, {
    resource: "evidence",
    action: "read",
    allow: entitled,
    resourceId: asset.id,
  });
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
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new AppError("VALIDATION_ERROR", "SHA256_FORMAT_INVALID");
  }
  const mimeType = input.mimeType ?? "image/jpeg";
  if (!ALLOWED_EVIDENCE_MIME_TYPES.has(mimeType)) {
    throw new AppError("VALIDATION_ERROR", "EVIDENCE_MIME_NOT_ALLOWED", { mimeType });
  }
  const sizeBytes = input.sizeBytes ?? 0;
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_EVIDENCE_BYTES) {
    throw new AppError("VALIDATION_ERROR", "EVIDENCE_SIZE_INVALID", { sizeBytes, maxBytes: MAX_EVIDENCE_BYTES });
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "evidence:register", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    if (!await resolveEvidenceOwnership(tx, principal, input.ownerType, input.ownerId)) {
      throw errors.notFound("evidence");
    }
    const [asset] = await tx.insert(evidenceAssets).values({
      organizationId: principal.organizationId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      sha256: input.sha256,
      purpose: input.purpose,
      mimeType,
      sizeBytes,
      status: "pending_upload",
      createdBy: principal.userId,
    }).returning({ id: evidenceAssets.id });
    return { evidenceId: asset.id, status: "pending_upload" as const };
  });
}

/**
 * Verifies uploaded evidence bytes against the registered SHA-256 digest, MIME allowlist and
 * 15 MB size ceiling, then transitions the asset from `pending_upload` to `verified`.
 */
export async function uploadEvidence(
  db: Db,
  principal: Principal,
  input: {
    evidenceId: string;
    contentBase64?: string;
    bytes?: Buffer;
    mimeType?: string;
    key: string;
  },
) {
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  const payloadBytes = input.bytes ?? (input.contentBase64 !== undefined ? Buffer.from(input.contentBase64, "base64") : null);
  if (!payloadBytes || payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new AppError("VALIDATION_ERROR", "EVIDENCE_SIZE_INVALID", {
      sizeBytes: payloadBytes?.byteLength ?? 0,
      maxBytes: MAX_EVIDENCE_BYTES,
    });
  }
  const actualSha256 = createHash("sha256").update(payloadBytes).digest("hex");

  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "evidence:upload",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({
      evidenceId: input.evidenceId,
      actualSha256,
      mimeType: input.mimeType ?? null,
      sizeBytes: payloadBytes.byteLength,
      actorId: principal.userId,
    }),
  }, async tx => {
    const [asset] = await tx.select().from(evidenceAssets).where(and(
      eq(evidenceAssets.id, input.evidenceId),
      eq(evidenceAssets.organizationId, principal.organizationId),
    )).limit(1);
    if (!asset) throw errors.notFound("evidence");
    await authorizeEvidenceOwner(tx, principal, asset);
    if (asset.deletedAt !== null || asset.status === "expired") {
      throw errors.notFound("evidence");
    }
    if (asset.status === "quarantined") {
      throw new AppError("FORBIDDEN", "EVIDENCE_QUARANTINED", { evidenceId: asset.id });
    }
    const effectiveMime = input.mimeType ?? asset.mimeType;
    if (!ALLOWED_EVIDENCE_MIME_TYPES.has(effectiveMime)) {
      throw new AppError("VALIDATION_ERROR", "EVIDENCE_MIME_NOT_ALLOWED", { mimeType: effectiveMime });
    }
    if (actualSha256 !== asset.sha256) {
      throw new AppError("VALIDATION_ERROR", "EVIDENCE_SHA256_MISMATCH", {
        expected: asset.sha256,
        actual: actualSha256,
      });
    }
    if (asset.status === "pending_upload") {
      await writeEvidenceBytes(asset.organizationId, asset.id, payloadBytes);
      await tx.update(evidenceAssets).set({
        status: "verified",
        mimeType: effectiveMime,
        sizeBytes: payloadBytes.byteLength,
      }).where(eq(evidenceAssets.id, asset.id));
      await appendEvent(tx, {
        principal,
        aggregateType: "evidence",
        aggregateId: asset.id,
        eventType: "evidence.verified",
        payload: {
          ownerType: asset.ownerType,
          ownerId: asset.ownerId,
          sha256: actualSha256,
          mimeType: effectiveMime,
          sizeBytes: payloadBytes.byteLength,
        },
      });
    }
    return {
      evidenceId: asset.id,
      status: asset.status === "pending_upload" ? ("verified" as const) : asset.status,
      sha256: actualSha256,
      mimeType: effectiveMime,
      sizeBytes: payloadBytes.byteLength,
    };
  });
}

export async function listEvidence(db: Db, principal: Principal, ownerType: string, ownerId: string) {
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  if (!await resolveEvidenceOwnership(db, principal, ownerType, ownerId)) {
    throw errors.notFound("evidence");
  }
  // The object storage key never leaves the service: the projection carries the digest and the
  // metadata a client needs to fetch the file through an authorized endpoint, nothing more.
  const rows = await db.select({
    id: evidenceAssets.id,
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
    isNull(evidenceAssets.deletedAt),
    ne(evidenceAssets.status, "expired"),
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
 * Lists non-expired evidence assets linked to a specific garment via `garment_evidence`,
 * enforcing the owning order's ABAC rules and never exposing `objectKey`.
 */
export async function listGarmentEvidence(db: Db, principal: Principal, garmentId: string) {
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  const [garment] = await db.select({
    id: garments.id,
    organizationId: garments.organizationId,
    orderId: garments.orderId,
  }).from(garments).where(and(
    eq(garments.id, garmentId),
    eq(garments.organizationId, principal.organizationId),
  )).limit(1);
  if (!garment) throw errors.notFound("garment");
  const entitled = entitledToOrder(principal, await loadScopedOrder(db, principal, garment.orderId));
  authorize(principal, {
    resource: "evidence",
    action: "list",
    organizationId: garment.organizationId,
    allow: entitled,
    resourceId: garment.id,
  });
  const rows = await db.select({
    id: evidenceAssets.id,
    sha256: evidenceAssets.sha256,
    purpose: evidenceAssets.purpose,
    mimeType: evidenceAssets.mimeType,
    sizeBytes: evidenceAssets.sizeBytes,
    status: evidenceAssets.status,
    createdAt: evidenceAssets.capturedAt,
  }).from(garmentEvidence)
    .innerJoin(evidenceAssets, eq(evidenceAssets.id, garmentEvidence.evidenceAssetId))
    .where(and(
      eq(garmentEvidence.organizationId, principal.organizationId),
      eq(garmentEvidence.garmentId, garment.id),
      isNull(evidenceAssets.deletedAt),
      ne(evidenceAssets.status, "expired"),
    ))
    .orderBy(desc(evidenceAssets.capturedAt));
  if (rows.length) {
    await db.insert(evidenceAccessEvents).values(
      rows.map(row => ({ assetId: row.id, actorId: principal.userId, purpose: "garment_listing" })),
    );
  }
  return rows;
}

async function loadServableEvidence(db: Db, principal: Principal, evidenceId: string) {
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES, "laundry_operator", ...ROLE_GROUPS.dispatcher);
  const [asset] = await db.select({
    id: evidenceAssets.id,
    organizationId: evidenceAssets.organizationId,
    ownerType: evidenceAssets.ownerType,
    ownerId: evidenceAssets.ownerId,
    sha256: evidenceAssets.sha256,
    purpose: evidenceAssets.purpose,
    mimeType: evidenceAssets.mimeType,
    sizeBytes: evidenceAssets.sizeBytes,
    status: evidenceAssets.status,
    deletedAt: evidenceAssets.deletedAt,
    capturedAt: evidenceAssets.capturedAt,
  }).from(evidenceAssets).where(and(
    eq(evidenceAssets.id, evidenceId),
    eq(evidenceAssets.organizationId, principal.organizationId),
  )).limit(1);
  if (!asset) throw errors.notFound("evidence");
  await authorizeEvidenceOwner(db, principal, asset);
  if (asset.deletedAt !== null || asset.status === "expired") throw errors.notFound("evidence");
  if (!SERVABLE_EVIDENCE_STATES.has(asset.status)) {
    throw new AppError("FORBIDDEN", "EVIDENCE_NOT_VERIFIED", { status: asset.status });
  }
  return asset;
}

/**
 * Single-asset read with the same object-scoped rule as the listing, and without the storage key.
 */
export async function readEvidence(db: Db, principal: Principal, evidenceId: string) {
  const asset = await loadServableEvidence(db, principal, evidenceId);
  await db.insert(evidenceAccessEvents).values({
    assetId: asset.id, actorId: principal.userId, purpose: "owner_read",
  });
  return {
    id: asset.id,
    ownerType: asset.ownerType,
    ownerId: asset.ownerId,
    sha256: asset.sha256,
    purpose: asset.purpose,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    status: asset.status,
    createdAt: asset.capturedAt,
  };
}

/**
 * Authorized binary download of a verified/retained/legal_hold evidence asset, verifying SHA-256
 * integrity on read and recording an access audit event.
 */
export async function readEvidenceContent(db: Db, principal: Principal, evidenceId: string) {
  const asset = await loadServableEvidence(db, principal, evidenceId);
  const bytes = await readEvidenceBytes(asset.organizationId, asset.id);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== asset.sha256) {
    throw new AppError("DEPENDENCY_UNAVAILABLE", "EVIDENCE_INTEGRITY_MISMATCH", {
      evidenceId: asset.id,
    });
  }
  await db.insert(evidenceAccessEvents).values({
    assetId: asset.id, actorId: principal.userId, purpose: "content_download",
  });
  return {
    bytes,
    mimeType: asset.mimeType,
    sha256: asset.sha256,
  };
}

export async function deleteEvidence(
  db: Db,
  principal: Principal,
  input: { evidenceId: string; key: string },
) {
  assertRole(principal, "customer", "courier", ...SUPPORT_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId,
    scope: "evidence:delete",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [asset] = await tx.select().from(evidenceAssets).where(and(
      eq(evidenceAssets.id, input.evidenceId),
      eq(evidenceAssets.organizationId, principal.organizationId),
    )).limit(1);
    if (!asset) throw errors.notFound("evidence");

    await authorizeEvidenceOwner(tx, principal, asset);

    // Customers may only delete evidence they themselves uploaded; staff/partner-captured
    // custody/QC/inspection evidence can only be deleted by support/claims/admin staff.
    if (!hasRole(principal, ...SUPPORT_ROLES) && asset.createdBy !== principal.userId) {
      throw errors.forbidden("only the uploader or support staff may delete this evidence");
    }

    if (asset.legalHoldCount > 0 || asset.status === "legal_hold") {
      throw new AppError("FINANCIAL_HOLD", "EVIDENCE_ON_LEGAL_HOLD", { evidenceId: asset.id });
    }
    const [activeHold] = await tx.select({ id: evidenceLegalHolds.id }).from(evidenceLegalHolds).where(and(
      eq(evidenceLegalHolds.organizationId, principal.organizationId),
      eq(evidenceLegalHolds.assetId, asset.id),
      isNull(evidenceLegalHolds.releasedAt),
    )).limit(1);
    if (activeHold) {
      throw new AppError("FINANCIAL_HOLD", "EVIDENCE_ON_LEGAL_HOLD", { evidenceId: asset.id, holdId: activeHold.id });
    }

    // Tombstone via `deleted_at`, never erase: the asset row, its access events and its legal holds
    // all stay intact so the audit trail survives deletion without overloading `status = 'expired'`.
    if (asset.deletedAt !== null) {
      return { evidenceId: asset.id, deleted: true as const, alreadyDeleted: true as const };
    }
    const deletedAt = new Date();
    const [tombstoned] = await tx.update(evidenceAssets).set({
      deletedAt,
    }).where(and(
      eq(evidenceAssets.id, asset.id),
      eq(evidenceAssets.legalHoldCount, 0),
      isNull(evidenceAssets.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM evidence_legal_holds h
        WHERE h.asset_id = ${evidenceAssets.id} AND h.released_at IS NULL
      )`,
    )).returning({ id: evidenceAssets.id });
    if (!tombstoned) {
      const [current] = await tx.select({
        deletedAt: evidenceAssets.deletedAt,
      }).from(evidenceAssets).where(eq(evidenceAssets.id, asset.id)).limit(1);
      if (current?.deletedAt !== null) {
        return { evidenceId: asset.id, deleted: true as const, alreadyDeleted: true as const };
      }
      throw new AppError("FINANCIAL_HOLD", "EVIDENCE_ON_LEGAL_HOLD", { evidenceId: asset.id });
    }
    await appendEvent(tx, {
      principal,
      aggregateType: "evidence",
      aggregateId: asset.id,
      eventType: "evidence.deleted",
      // The digest identifies the object for the audit trail; the storage key is never published.
      payload: { ownerType: asset.ownerType, ownerId: asset.ownerId, sha256: asset.sha256, deletedAt: deletedAt.toISOString() },
    });
    return { evidenceId: asset.id, deleted: true as const, deletedAt };
  });
}

/**
 * Retention sweep: expires evidence assets past `retention_until` that have no active legal holds
 * and have not yet been tombstoned, while preserving `evidence_access_events` and `evidence_legal_holds`.
 */
export async function runEvidenceRetentionSweep(db: Db, now = new Date()) {
  const expired = await db.update(evidenceAssets)
    .set({ status: "expired", deletedAt: now })
    .where(and(
      lte(evidenceAssets.retentionUntil, now),
      eq(evidenceAssets.legalHoldCount, 0),
      isNull(evidenceAssets.deletedAt),
      sql`NOT EXISTS (
        SELECT 1 FROM evidence_legal_holds h
        WHERE h.asset_id = ${evidenceAssets.id} AND h.released_at IS NULL
      )`,
    ))
    .returning({ id: evidenceAssets.id });
  return { expired: expired.length, expiredIds: expired.map(row => row.id) };
}

async function paginateAll<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(pageSize, offset);
    all.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return all;
}

/**
 * Privacy export for the signed-in user: returns only the caller's own non-internal records
 * scoped to their tenant. Never exposes internal hashes, door codes, storage keys, or other users' data.
 */
export async function exportMyPrivacyData(db: Db, principal: Principal) {
  const [[user], addressRows, orderRows, claimRows, notificationRows, reviewRows] = await Promise.all([
    db.select({
      id: users.id,
      phone: users.phone,
      displayName: users.displayName,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, principal.userId)).limit(1),
    paginateAll((limit, offset) =>
      db.select({
        id: customerAddresses.id,
        buildingId: customerAddresses.buildingId,
        address: buildings.address,
        apartment: customerAddresses.apartment,
        notes: customerAddresses.notes,
        createdAt: customerAddresses.createdAt,
      }).from(customerAddresses)
        .innerJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
        .where(and(
          eq(customerAddresses.organizationId, principal.organizationId),
          eq(customerAddresses.customerId, principal.userId),
        ))
        .orderBy(desc(customerAddresses.createdAt), desc(customerAddresses.id))
        .limit(limit)
        .offset(offset),
    ),
    paginateAll((limit, offset) =>
      db.select({
        id: orders.id,
        publicNumber: orders.publicNumber,
        lifecycleState: orders.lifecycleState,
        createdAt: orders.createdAt,
      }).from(orders).where(and(
        eq(orders.organizationId, principal.organizationId),
        eq(orders.customerId, principal.userId),
      )).orderBy(desc(orders.createdAt), desc(orders.id)).limit(limit).offset(offset),
    ),
    paginateAll((limit, offset) =>
      db.select({
        id: claims.id,
        orderId: claims.orderId,
        claimType: claims.claimType,
        state: claims.state,
        description: claims.description,
        openedAt: claims.openedAt,
      }).from(claims).where(and(
        eq(claims.organizationId, principal.organizationId),
        eq(claims.openedBy, principal.userId),
      )).orderBy(desc(claims.openedAt), desc(claims.id)).limit(limit).offset(offset),
    ),
    paginateAll((limit, offset) =>
      db.select({
        id: notifications.id,
        orderId: notifications.orderId,
        channel: notifications.channel,
        template: notifications.template,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      }).from(notifications).where(and(
        eq(notifications.organizationId, principal.organizationId),
        eq(notifications.recipientId, principal.userId),
      )).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit).offset(offset),
    ),
    paginateAll((limit, offset) =>
      db.select({
        id: reviews.id,
        orderId: reviews.orderId,
        rating: reviews.rating,
        body: reviews.body,
        state: reviews.state,
        createdAt: reviews.createdAt,
      }).from(reviews).where(and(
        eq(reviews.organizationId, principal.organizationId),
        eq(reviews.customerId, principal.userId),
      )).orderBy(desc(reviews.createdAt), desc(reviews.id)).limit(limit).offset(offset),
    ),
  ]);

  const exportedAt = new Date().toISOString();
  return {
    exportedAt,
    exportMeta: {
      complete: true as const,
      exportedAt,
      counts: {
        addresses: addressRows.length,
        orders: orderRows.length,
        claims: claimRows.length,
        notifications: notificationRows.length,
        reviews: reviewRows.length,
      },
    },
    profile: user ?? { id: principal.userId, phone: null, displayName: null, createdAt: null },
    addresses: addressRows,
    orders: orderRows,
    claims: claimRows,
    notifications: notificationRows,
    reviews: reviewRows,
  };
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
    )).limit(1).for("update");
    if (!compensation) throw errors.notFound("compensation");
    if (compensation.state !== "proposed") {
      return { compensationId: compensation.id, state: compensation.state, alreadyDecided: true as const };
    }
    const state = input.approve ? "approved" : "denied";
    const [updated] = await tx.update(compensations).set({ state, approvedBy: principal.userId })
      .where(and(
        eq(compensations.id, compensation.id),
        eq(compensations.organizationId, principal.organizationId),
        eq(compensations.state, "proposed"),
      ))
      .returning({ id: compensations.id });
    if (!updated) {
      const [current] = await tx.select({ state: compensations.state }).from(compensations).where(and(
        eq(compensations.id, compensation.id),
        eq(compensations.organizationId, principal.organizationId),
      )).limit(1);
      return { compensationId: compensation.id, state: current?.state ?? compensation.state, alreadyDecided: true as const };
    }
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
