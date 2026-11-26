import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "./01-identity.js";
import { orders } from "./04-orders.js";

/**
 * An escalation of an order that got stuck.
 *
 * Before this table a jammed order had no owner: the lifecycle had no transition out of it,
 * so an order sitting in `at_hub` without a factory simply stopped. An escalation names the
 * person who noticed the jam, the reason it happened, the person who owns the fix and the
 * way out of it — the resolution text and who closed it.
 *
 * The row is the record of the jam, so it outlives the order's movement: a resolved
 * escalation stays readable, and only an order with an OPEN escalation is still stuck.
 */
export const orderEscalations = pgTable("order_escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  escalatedBy: uuid("escalated_by").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  assigneeId: uuid("assignee_id").references(() => users.id),
  state: text("state").notNull().default("open"),
  resolution: text("resolution"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("order_escalations_org_order_idx").on(t.organizationId, t.orderId),
  // The dispatcher only ever asks for the open escalations of the tenant, so the partial index
  // covers the hot query without paying for the resolved history.
  index("order_escalations_org_open_idx")
    .on(t.organizationId, t.state)
    .where(sql`${t.state} = 'open'`),
]);
