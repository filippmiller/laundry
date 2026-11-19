import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";
import { orders } from "./04-orders.js";
import { containers, garments } from "./06-items.js";
import { scanSyncState, evidenceState, disputeState } from "./enums.js";

export const scanEvents = pgTable("scan_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  deviceId: uuid("device_id").notNull(),
  clientEventId: uuid("client_event_id").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  scannedType: text("scanned_type").notNull(),
  scannedId: text("scanned_id").notNull(),
  contextJson: jsonb("context_json").notNull().default({}),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payloadHash: text("payload_hash").notNull(),
  syncStatus: scanSyncState("sync_status").notNull().default("pending"),
}, t => [
  uniqueIndex("scan_events_device_client_unique").on(t.deviceId, t.clientEventId),
  index("scan_events_actor_idx").on(t.organizationId, t.actorId, t.capturedAt),
]);

export const custodyEvents = pgTable("custody_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  containerId: uuid("container_id").references(() => containers.id),
  fromParty: text("from_party").notNull(),
  toParty: text("to_party").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  manifestId: uuid("manifest_id"),
  manifestHash: text("manifest_hash").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("custody_events_order_time_idx").on(t.organizationId, t.orderId, t.occurredAt),
  index("custody_events_container_time_idx").on(t.containerId, t.occurredAt),
]);

export const custodyDiscrepancies = pgTable("custody_discrepancies", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  kind: text("kind").notNull(),
  detailsJson: jsonb("details_json").notNull().default({}),
  state: disputeState("state").notNull().default("open"),
  openedBy: uuid("opened_by").references(() => users.id),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("custody_discrepancies_order_idx").on(t.organizationId, t.orderId)]);

export const evidenceAssets = pgTable("evidence_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  ownerType: text("owner_type").notNull(),
  ownerId: uuid("owner_id").notNull(),
  objectKey: text("object_key").notNull(),
  sha256: text("sha256").notNull(),
  purpose: text("purpose").notNull(),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  legalHoldCount: integer("legal_hold_count").notNull().default(0),
  status: evidenceState("status").notNull().default("pending_upload"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
}, t => [
  uniqueIndex("evidence_object_key_unique").on(t.objectKey),
  index("evidence_owner_idx").on(t.organizationId, t.ownerType, t.ownerId),
]);

export const evidenceAccessEvents = pgTable("evidence_access_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id").notNull().references(() => evidenceAssets.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  purpose: text("purpose").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("evidence_access_asset_idx").on(t.assetId, t.occurredAt)]);

export const evidenceLegalHolds = pgTable("evidence_legal_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  assetId: uuid("asset_id").notNull().references(() => evidenceAssets.id),
  claimId: uuid("claim_id"),
  reason: text("reason").notNull(),
  placedBy: uuid("placed_by").references(() => users.id),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("evidence_holds_asset_idx").on(t.assetId, t.releasedAt)]);

export const garmentEvidence = pgTable("garment_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  garmentId: uuid("garment_id").notNull().references(() => garments.id, { onDelete: "cascade" }),
  evidenceAssetId: uuid("evidence_asset_id").notNull().references(() => evidenceAssets.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("garment_evidence_garment_asset_unique").on(t.garmentId, t.evidenceAssetId),
  index("garment_evidence_org_garment_idx").on(t.organizationId, t.garmentId),
]);
