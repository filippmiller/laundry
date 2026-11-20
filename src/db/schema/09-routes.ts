import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";
import { buildings } from "./02-geography.js";
import { orders } from "./04-orders.js";
import { scanEvents } from "./07-evidence.js";
import { shiftState, routeStopState, attemptOutcome } from "./enums.js";

export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  plate: text("plate").notNull(),
  capacityWeightGrams: integer("capacity_weight_grams").notNull().default(0),
  capacityVolumeLitres: integer("capacity_volume_litres").notNull().default(0),
  active: boolean("active").notNull().default(true),
}, t => [uniqueIndex("vehicles_org_plate_unique").on(t.organizationId, t.plate)]);

export const courierShifts = pgTable("courier_shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  courierId: uuid("courier_id").notNull().references(() => users.id),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id),
  state: shiftState("state").notNull().default("planned"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("shifts_courier_idx").on(t.organizationId, t.courierId, t.state),
  uniqueIndex("courier_shifts_org_courier_active_unique")
    .on(t.organizationId, t.courierId)
    .where(sql`${t.state} = 'active'`),
]);

export const shiftReconciliationAdjustments = pgTable("shift_reconciliation_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  shiftId: uuid("shift_id").notNull().references(() => courierShifts.id),
  scanEventId: uuid("scan_event_id").notNull().references(() => scanEvents.id),
  deltaAccepted: integer("delta_accepted").notNull().default(0),
  deltaRejected: integer("delta_rejected").notNull().default(0),
  reason: text("reason").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("shift_recon_adj_scan_unique").on(t.scanEventId),
  index("shift_recon_adj_shift_idx").on(t.organizationId, t.shiftId, t.recordedAt),
]);

export const routes = pgTable("routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  shiftId: uuid("shift_id").notNull().references(() => courierShifts.id),
  kind: text("kind").notNull(),
  state: text("state").notNull().default("planned"),
  plannedStart: timestamp("planned_start", { withTimezone: true }).notNull(),
  plannedEnd: timestamp("planned_end", { withTimezone: true }).notNull(),
  optimizedBy: text("optimized_by").notNull().default("manual"),
}, t => [index("routes_shift_idx").on(t.shiftId)]);

export const routeStops = pgTable("route_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  routeId: uuid("route_id").notNull().references(() => routes.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  buildingId: uuid("building_id").references(() => buildings.id),
  kind: text("kind").notNull(),
  sequence: integer("sequence").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  state: routeStopState("state").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  assignedCourierId: uuid("assigned_courier_id").references(() => users.id),
}, t => [
  uniqueIndex("route_stops_route_sequence_unique").on(t.routeId, t.sequence),
  index("route_stops_order_idx").on(t.organizationId, t.orderId),
]);

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  stopId: uuid("stop_id").notNull().references(() => routeStops.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  outcome: attemptOutcome("outcome").notNull(),
  deliveredGarmentIds: jsonb("delivered_garment_ids").notNull().default([]),
  recipientProofJson: jsonb("recipient_proof_json").notNull().default({}),
  reason: text("reason"),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("delivery_attempts_order_idx").on(t.organizationId, t.orderId)]);
