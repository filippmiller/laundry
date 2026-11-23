import { pgTable, uuid, text, integer, bigint, timestamp, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, partners, users } from "./01-identity.js";
import { partnerContracts, partnerPriceVersions } from "./03-catalog.js";
import { orders, orderLines } from "./04-orders.js";
import { garments, containers, seals, intakeManifests } from "./06-items.js";
import { custodyDiscrepancies } from "./07-evidence.js";
import { receiptState, batchState } from "./enums.js";

export const partnerReceipts = pgTable("partner_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  manifestId: uuid("manifest_id").references(() => intakeManifests.id),
  discrepancyId: uuid("discrepancy_id").references(() => custodyDiscrepancies.id),
  expectedHash: text("expected_hash").notNull(),
  actualHash: text("actual_hash"),
  state: receiptState("state").notNull().default("expected"),
  receivedBy: uuid("received_by").references(() => users.id),
  receivedAt: timestamp("received_at", { withTimezone: true }),
}, t => [index("partner_receipts_partner_idx").on(t.organizationId, t.partnerId, t.state)]);

export const partnerReceiptLines = pgTable("partner_receipt_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().references(() => partnerReceipts.id, { onDelete: "cascade" }),
  containerId: uuid("container_id").notNull().references(() => containers.id),
  expectedSealId: uuid("expected_seal_id").references(() => seals.id),
  actualSealId: uuid("actual_seal_id").references(() => seals.id),
  expectedWeightGrams: integer("expected_weight_grams"),
  actualWeightGrams: integer("actual_weight_grams"),
  status: text("status").notNull().default("pending"),
}, t => [index("receipt_lines_receipt_idx").on(t.receiptId)]);

export const batches = pgTable("batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  processType: text("process_type").notNull(),
  state: batchState("state").notNull().default("created"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("batches_partner_idx").on(t.organizationId, t.partnerId, t.state)]);

export const batchItems = pgTable("batch_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  garmentId: uuid("garment_id").references(() => garments.id),
  orderLineId: uuid("order_line_id").references(() => orderLines.id),
  status: text("status").notNull().default("queued"),
}, t => [uniqueIndex("batch_items_unique").on(t.batchId, t.garmentId, t.orderLineId)]);

export const processingOperations = pgTable("processing_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  batchId: uuid("batch_id").notNull().references(() => batches.id),
  batchItemId: uuid("batch_item_id").references(() => batchItems.id),
  operation: text("operation").notNull(),
  detailsJson: jsonb("details_json").notNull().default({}),
  actorId: uuid("actor_id").references(() => users.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("processing_ops_batch_idx").on(t.batchId)]);

export const qualityChecks = pgTable("quality_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  garmentId: uuid("garment_id").references(() => garments.id),
  result: text("result").notNull(),
  note: text("note"),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("quality_checks_order_idx").on(t.organizationId, t.orderId)]);

export const partnerServiceAccruals = pgTable("partner_service_accruals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  orderLineId: uuid("order_line_id").notNull().references(() => orderLines.id),
  contractId: uuid("contract_id").notNull().references(() => partnerContracts.id),
  contractPriceVersionId: uuid("contract_price_version_id").references(() => partnerPriceVersions.id),
  quantity: integer("quantity").notNull(),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  status: text("status").notNull().default("estimated"),
  disputed: boolean("disputed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("accruals_partner_status_idx").on(t.partnerId, t.status)]);
