import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, reviewLikes, reviews } from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { loadOrder } from "./orders.js";

const MODERATION_ROLES = [...ROLE_GROUPS.support, ...ROLE_GROUPS.admin] as const;

export async function createReview(
  db: Db,
  principal: Principal,
  input: { orderId: string; rating: number; body: string; key: string },
) {
  assertRole(principal, "customer");
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new AppError("VALIDATION_ERROR", "RATING_OUT_OF_RANGE");
  }
  if (input.body.length > 2_000) throw new AppError("VALIDATION_ERROR", "REVIEW_TOO_LONG");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "review:create", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
    replayGuard: async tx => { await loadOrder(tx as Db, principal, input.orderId); },
  }, async tx => {
    const order = await loadOrder(tx, principal, input.orderId);
    if (!["delivered", "closed"].includes(order.lifecycleState)) {
      throw new AppError("INVALID_TRANSITION", "ORDER_NOT_COMPLETED", { state: order.lifecycleState });
    }
    const inserted = await tx.insert(reviews).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      customerId: principal.userId,
      rating: input.rating,
      body: input.body,
    }).onConflictDoNothing().returning({ id: reviews.id });
    if (!inserted.length) throw new AppError("CONFLICT_VERSION", "REVIEW_EXISTS");
    return { reviewId: inserted[0].id, orderId: order.id, rating: input.rating, state: "published" as const };
  });
}

export async function listReviews(db: Db, principal: Principal, input: { limit?: number } = {}) {
  const limit = Math.min(input.limit ?? 50, 100);
  const rows = await db.execute(sql`
    SELECT r.id,
           r.rating,
           r.body,
           r.created_at AS "createdAt",
           (SELECT count(*)::int FROM review_likes l WHERE l.review_id = r.id) AS "likeCount",
           EXISTS (SELECT 1 FROM review_likes l WHERE l.review_id = r.id AND l.user_id = ${principal.userId}) AS "likedByMe"
    FROM reviews r
    WHERE r.organization_id = ${principal.organizationId} AND r.state = 'published'
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);
  return rows.rows as Array<{
    id: string; rating: number; body: string; createdAt: string; likeCount: number; likedByMe: boolean;
  }>;
}

async function publishedReview(db: Db, principal: Principal, reviewId: string) {
  const [review] = await db.select().from(reviews).where(and(
    eq(reviews.id, reviewId),
    eq(reviews.organizationId, principal.organizationId),
    eq(reviews.state, "published"),
  )).limit(1);
  if (!review) throw errors.notFound("review");
  return review;
}

export async function likeReview(db: Db, principal: Principal, input: { reviewId: string; key: string }) {
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "review:like", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const review = await publishedReview(tx, principal, input.reviewId);
    await tx.insert(reviewLikes).values({ reviewId: review.id, userId: principal.userId }).onConflictDoNothing();
    return { reviewId: review.id, liked: true };
  });
}

export async function unlikeReview(db: Db, principal: Principal, input: { reviewId: string }) {
  const review = await publishedReview(db, principal, input.reviewId);
  await db.delete(reviewLikes).where(and(
    eq(reviewLikes.reviewId, review.id),
    eq(reviewLikes.userId, principal.userId),
  ));
  return { reviewId: review.id, liked: false };
}

export async function hideReview(
  db: Db,
  principal: Principal,
  input: { reviewId: string; reason: string; key: string },
) {
  assertRole(principal, ...MODERATION_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "review:hide", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [review] = await tx.select().from(reviews).where(and(
      eq(reviews.id, input.reviewId),
      eq(reviews.organizationId, principal.organizationId),
    )).limit(1);
    if (!review) throw errors.notFound("review");
    if (review.state === "hidden") return { reviewId: review.id, state: "hidden" as const };
    await tx.update(reviews).set({ state: "hidden", hiddenReason: input.reason }).where(eq(reviews.id, review.id));
    await tx.insert(auditEvents).values({
      organizationId: principal.organizationId,
      actorId: principal.userId,
      action: "review.hidden",
      resourceType: "review",
      resourceId: review.id,
      reason: input.reason,
      requestId: principal.requestId,
    });
    return { reviewId: review.id, state: "hidden" as const };
  });
}
