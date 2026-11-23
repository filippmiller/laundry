import { pgTable, uuid, text, integer, timestamp, check, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "./01-identity.js";
import { orders } from "./04-orders.js";

/**
 * One customer review per completed order. Moderation is a state, never a delete: the record
 * stays for the audit trail while a hidden review disappears from the public list.
 */
export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  rating: integer("rating").notNull(),
  body: text("body").notNull().default(""),
  state: text("state").notNull().default("published"),
  hiddenReason: text("hidden_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("reviews_rating_range", sql`${t.rating} >= 1 AND ${t.rating} <= 5`),
  uniqueIndex("reviews_order_unique").on(t.orderId),
  index("reviews_org_created_idx").on(t.organizationId, t.createdAt),
]);

export const reviewLikes = pgTable("review_likes", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("review_likes_unique").on(t.reviewId, t.userId)]);
