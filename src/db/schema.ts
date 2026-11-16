import { pgTable, uuid, text, timestamp, integer, bigint, jsonb, uniqueIndex, index, check, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orderState = pgEnum("order_state", ["draft", "confirmed", "scheduled", "pickup_assigned", "picked_up", "at_hub", "partner_received", "inspection", "awaiting_approval", "processing", "quality_check", "ready", "out_for_delivery", "delivered", "closed", "cancelled"]);
export const reservationState = pgEnum("reservation_state", ["held", "confirmed", "released", "expired"]);
export const windowKind = pgEnum("window_kind", ["pickup", "delivery"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const buildings = pgTable("buildings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  address: text("address").notNull(),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
}, t => [index("buildings_org_idx").on(t.organizationId)]);
export const serviceWindows = pgTable("service_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  buildingId: uuid("building_id").notNull().references(() => buildings.id),
  kind: windowKind("kind").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  capacityOrders: integer("capacity_orders").notNull(),
  reservedOrders: integer("reserved_orders").notNull().default(0),
  feeKopeks: bigint("fee_kopeks", { mode: "number" }).notNull().default(0),
  version: integer("version").notNull().default(1),
}, t => [
  check("window_capacity_nonnegative", sql`${t.capacityOrders} >= 0 AND ${t.reservedOrders} >= 0 AND ${t.reservedOrders} <= ${t.capacityOrders}`),
  check("window_time_order", sql`${t.endsAt} > ${t.startsAt}`),
  check("window_fee_nonnegative", sql`${t.feeKopeks} >= 0`),
]);
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  buildingId: uuid("building_id").notNull().references(() => buildings.id),
  publicNumber: text("public_number").notNull(),
  state: orderState("state").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("orders_org_public_unique").on(t.organizationId, t.publicNumber), index("orders_customer_idx").on(t.organizationId,t.customerId)]);
export const slotReservations = pgTable("slot_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  windowId: uuid("window_id").notNull().references(() => serviceWindows.id),
  orderId: uuid("order_id").references(() => orders.id),
  state: reservationState("state").notNull().default("held"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("reservation_window_idempotency_unique").on(t.windowId,t.idempotencyKey)]);
export const containers = pgTable("containers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
});
export const custodyEvents = pgTable("custody_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  containerId: uuid("container_id").notNull().references(() => containers.id),
  fromParty: text("from_party").notNull(),
  toParty: text("to_party").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  manifestHash: text("manifest_hash").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("custody_container_time_idx").on(t.containerId,t.occurredAt)]);
export const idempotencyRecords = pgTable("idempotency_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response"),
}, t => [uniqueIndex("idempotency_scope_unique").on(t.organizationId,t.scope,t.key)]);
