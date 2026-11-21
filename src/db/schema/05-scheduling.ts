import { pgTable, uuid, text, bigint, integer, timestamp, jsonb, boolean, check, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "./01-identity.js";
import { buildings } from "./02-geography.js";
import { quotes, orders } from "./04-orders.js";
import { windowKind, windowStatus, reservationState } from "./enums.js";

export const serviceWindows = pgTable("service_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  buildingId: uuid("building_id").notNull().references(() => buildings.id),
  kind: windowKind("kind").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  isShared: boolean("is_shared").notNull().default(true),
  status: windowStatus("status").notNull().default("open"),
  capacityOrders: integer("capacity_orders").notNull(),
  reservedOrders: integer("reserved_orders").notNull().default(0),
  capacityWeightGrams: integer("capacity_weight_grams").notNull().default(0),
  reservedWeightGrams: integer("reserved_weight_grams").notNull().default(0),
  safetyBufferOrders: integer("safety_buffer_orders").notNull().default(0),
  feeKopeks: bigint("fee_kopeks", { mode: "number" }).notNull().default(0),
  version: integer("version").notNull().default(1),
}, t => [
  check("window_time_order", sql`${t.endsAt} > ${t.startsAt}`),
  check("window_capacity_nonnegative", sql`${t.capacityOrders} >= 0 AND ${t.reservedOrders} >= 0 AND ${t.reservedOrders} <= ${t.capacityOrders}`),
  check("window_weight_nonnegative", sql`${t.capacityWeightGrams} >= 0 AND ${t.reservedWeightGrams} >= 0 AND ${t.reservedWeightGrams} <= ${t.capacityWeightGrams}`),
  check("window_fee_nonnegative", sql`${t.feeKopeks} >= 0`),
  index("windows_org_building_idx").on(t.organizationId, t.buildingId, t.kind),
  index("windows_status_time_idx").on(t.status, t.startsAt),
]);

export const slotReservations = pgTable("slot_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  windowId: uuid("window_id").notNull().references(() => serviceWindows.id),
  orderId: uuid("order_id").references(() => orders.id),
  quoteId: uuid("quote_id").references(() => quotes.id),
  principalId: uuid("principal_id").notNull().references(() => users.id),
  state: reservationState("state").notNull().default("held"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  capacityUnits: integer("capacity_units").notNull().default(1),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("reservation_window_idempotency_unique").on(t.windowId, t.idempotencyKey),
  index("reservations_expiry_idx").on(t.state, t.expiresAt),
  index("reservations_window_state_idx").on(t.windowId, t.state),
]);

export const slotExceptionQuotes = pgTable("slot_exception_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  orderId: uuid("order_id").references(() => orders.id),
  windowId: uuid("window_id").references(() => serviceWindows.id),
  kind: windowKind("kind").notNull(),
  feeKopeks: bigint("fee_kopeks", { mode: "number" }).notNull(),
  snapshotJson: jsonb("snapshot_json").notNull(),
  quoteHash: text("quote_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("quoted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("exception_quotes_customer_idx").on(t.organizationId, t.customerId)]);

export const slotExceptionRequests = pgTable("slot_exception_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  quoteId: uuid("quote_id").notNull().references(() => slotExceptionQuotes.id),
  reservationId: uuid("reservation_id").references(() => slotReservations.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  state: text("state").notNull().default("awaiting_consent"),
  paymentIntentRef: text("payment_intent_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
