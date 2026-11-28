import { pgTable, uuid, text, bigint, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";
import { orders } from "./04-orders.js";
import { garments } from "./06-items.js";
import { claimState, outboxState } from "./enums.js";

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  openedBy: uuid("opened_by").notNull().references(() => users.id),
  claimType: text("claim_type").notNull(),
  state: claimState("state").notNull().default("opened"),
  description: text("description").notNull(),
  version: integer("version").notNull().default(1),
  dueAt: timestamp("due_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("claims_org_state_due_idx").on(t.organizationId, t.state, t.dueAt)]);

export const claimItems = pgTable("claim_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: uuid("claim_id").notNull().references(() => claims.id, { onDelete: "cascade" }),
  garmentId: uuid("garment_id").references(() => garments.id),
  issue: text("issue").notNull(),
});

export const claimDecisions = pgTable("claim_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  version: integer("version").notNull(),
  outcome: text("outcome").notNull(),
  rationale: text("rationale").notNull(),
  approvedBy: uuid("approved_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("claim_decisions_claim_version_unique").on(t.claimId, t.version)]);

export const compensations = pgTable("compensations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  claimId: uuid("claim_id").notNull().references(() => claims.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("proposed"),
  approvedBy: uuid("approved_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportThreads = pgTable("support_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").references(() => orders.id),
  subject: text("subject").notNull(),
  state: text("state").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportMessages = pgTable("support_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => supportThreads.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A support reply that has not been sent yet.
 *
 * The draft belongs to its author: one draft per (thread, author), visible only to that author,
 * and it survives the closing of the thread so a half-written answer is not lost.
 */
export const supportMessageDrafts = pgTable("support_message_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  threadId: uuid("thread_id").notNull().references(() => supportThreads.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("support_message_drafts_thread_author_unique").on(t.threadId, t.authorId),
  index("support_message_drafts_thread_idx").on(t.threadId),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  recipientId: uuid("recipient_id").references(() => users.id),
  orderId: uuid("order_id").references(() => orders.id),
  channel: text("channel").notNull().default("sms"),
  template: text("template").notNull(),
  payloadJson: jsonb("payload_json").notNull().default({}),
  dedupeKey: text("dedupe_key").notNull(),
  state: text("state").notNull().default("pending"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("notifications_dedupe_unique").on(t.organizationId, t.dedupeKey)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  scopeJson: jsonb("scope_json").notNull().default({}),
  reason: text("reason"),
  requestId: text("request_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("audit_events_org_time_idx").on(t.organizationId, t.occurredAt)]);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: jsonb("payload_json").notNull().default({}),
  state: outboxState("state").notNull().default("pending"),
  deliveryStatus: text("delivery_status").notNull().default("queued"),
  providerReceipt: text("provider_receipt"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("outbox_pending_idx").on(t.state, t.availableAt)]);

export const idempotencyRecords = pgTable("idempotency_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  requestHash: text("request_hash").notNull(),
  responseJson: jsonb("response_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, t => [uniqueIndex("idempotency_scope_unique").on(t.organizationId, t.scope, t.key)]);
