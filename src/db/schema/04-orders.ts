import { pgTable, uuid, text, bigint, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";
import { customerAddresses } from "./02-geography.js";
import { tariffVersions, services } from "./03-catalog.js";
import { orderState, quoteState, tierEnum, adjustmentState } from "./enums.js";

export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  tariffVersionId: uuid("tariff_version_id").notNull().references(() => tariffVersions.id),
  state: quoteState("state").notNull().default("active"),
  snapshotJson: jsonb("snapshot_json").notNull(),
  quoteHash: text("quote_hash").notNull(),
  totalKopeks: bigint("total_kopeks", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("quotes_org_customer_idx").on(t.organizationId, t.customerId)]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  addressId: uuid("address_id").notNull().references(() => customerAddresses.id),
  quoteId: uuid("quote_id").notNull().references(() => quotes.id),
  publicNumber: text("public_number").notNull(),
  lifecycleState: orderState("lifecycle_state").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  termsVersion: text("terms_version").notNull(),
  acceptedQuoteHash: text("accepted_quote_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("orders_org_public_unique").on(t.organizationId, t.publicNumber),
  index("orders_org_customer_idx").on(t.organizationId, t.customerId, t.createdAt),
  index("orders_org_state_idx").on(t.organizationId, t.lifecycleState),
]);

export const orderLines = pgTable("order_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  tier: tierEnum("tier").notNull(),
  quotedQuantity: integer("quoted_quantity").notNull(),
  actualQuantity: integer("actual_quantity"),
  unit: text("unit").notNull().default("piece"),
  quotedAmountKopeks: bigint("quoted_amount_kopeks", { mode: "number" }).notNull(),
  finalAmountKopeks: bigint("final_amount_kopeks", { mode: "number" }),
  tariffSnapshotJson: jsonb("tariff_snapshot_json").notNull(),
  status: text("status").notNull().default("quoted"),
}, t => [index("order_lines_order_idx").on(t.orderId)]);

export const orderAdjustments = pgTable("order_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  proposedBy: uuid("proposed_by").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  deltaKopeks: bigint("delta_kopeks", { mode: "number" }).notNull(),
  state: adjustmentState("state").notNull().default("proposed"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("adjustments_order_idx").on(t.orderId, t.state)]);

export const customerApprovals = pgTable("customer_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  adjustmentId: uuid("adjustment_id").references(() => orderAdjustments.id),
  quoteHash: text("quote_hash").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  method: text("method").notNull(),
  evidenceRef: text("evidence_ref"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("approvals_order_idx").on(t.orderId)]);

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  kind: text("kind").notNull(),
  version: text("version").notNull(),
  contentHash: text("content_hash").notNull(),
  bodyText: text("body_text").notNull(),
  publishedBy: uuid("published_by").references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("document_versions_org_kind_version_unique").on(t.organizationId, t.kind, t.version)]);
