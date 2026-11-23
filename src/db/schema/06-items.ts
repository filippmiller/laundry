import { pgTable, uuid, text, integer, bigint, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";
import { orders, orderLines } from "./04-orders.js";
import { manifestMode, sealState } from "./enums.js";

export const garments = pgTable("garments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  orderLineId: uuid("order_line_id").references(() => orderLines.id),
  itemCode: text("item_code").notNull().unique(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  brandMark: text("brand_mark"),
  declaredValueKopeks: bigint("declared_value_kopeks", { mode: "number" }),
  conditionJson: jsonb("condition_json").notNull().default({}),
  status: text("status").notNull().default("declared"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("garments_order_idx").on(t.organizationId, t.orderId)]);

export const containers = pgTable("containers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  code: text("code").notNull(),
  kind: text("kind").notNull().default("bag"),
  active: boolean("active").notNull().default(true),
}, t => [
  uniqueIndex("containers_org_code_unique").on(t.organizationId, t.code),
  index("containers_org_idx").on(t.organizationId),
]);

export const seals = pgTable("seals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  serialNumber: text("serial_number").notNull().unique(),
  state: sealState("state").notNull().default("available"),
}, t => [index("seals_org_idx").on(t.organizationId)]);

export const containerAssignments = pgTable("container_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  containerId: uuid("container_id").notNull().references(() => containers.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  sealId: uuid("seal_id").references(() => seals.id),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
}, t => [index("container_assignments_order_idx").on(t.organizationId, t.orderId)]);

export const intakeManifests = pgTable("intake_manifests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  containerId: uuid("container_id").references(() => containers.id),
  mode: manifestMode("mode").notNull(),
  count: integer("count").notNull(),
  weightGrams: integer("weight_grams").notNull().default(0),
  manifestHash: text("manifest_hash").notNull(),
  customerConfirmationId: uuid("customer_confirmation_id").references(() => users.id),
  courierConfirmationId: uuid("courier_confirmation_id").references(() => users.id),
  state: text("state").notNull().default("accepted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("manifests_order_idx").on(t.organizationId, t.orderId)]);

export const intakeManifestLines = pgTable("intake_manifest_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  manifestId: uuid("manifest_id").notNull().references(() => intakeManifests.id, { onDelete: "cascade" }),
  garmentId: uuid("garment_id").references(() => garments.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  weightGrams: integer("weight_grams").notNull().default(0),
}, t => [index("manifest_lines_manifest_idx").on(t.manifestId)]);

export const garmentContainerEvents = pgTable("garment_container_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  garmentId: uuid("garment_id").notNull().references(() => garments.id),
  containerId: uuid("container_id").notNull().references(() => containers.id),
  event: text("event").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("garment_container_events_garment_idx").on(t.garmentId, t.occurredAt)]);
