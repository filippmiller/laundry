import { pgTable, uuid, text, timestamp, doublePrecision, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./01-identity.js";

export const cities = pgTable("cities", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  active: text("active").notNull().default("true"),
}, t => [uniqueIndex("cities_org_name_unique").on(t.organizationId, t.name)]);

export const serviceZones = pgTable("service_zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  name: text("name").notNull(),
  polygonJson: text("polygon_json"),
}, t => [index("zones_city_idx").on(t.cityId)]);

export const buildings = pgTable("buildings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  zoneId: uuid("zone_id").references(() => serviceZones.id),
  address: text("address").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  accessNotes: text("access_notes"),
  active: text("active").notNull().default("true"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("buildings_org_address_unique").on(t.organizationId, t.address),
  index("buildings_org_idx").on(t.organizationId),
]);

export const entrances = pgTable("entrances", {
  id: uuid("id").primaryKey().defaultRandom(),
  buildingId: uuid("building_id").notNull().references(() => buildings.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  accessCodeHash: text("access_code_hash"),
}, t => [uniqueIndex("entrances_building_label_unique").on(t.buildingId, t.label)]);

export const customerAddresses = pgTable("customer_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  customerId: uuid("customer_id").notNull().references(() => users.id),
  buildingId: uuid("building_id").notNull().references(() => buildings.id),
  entranceId: uuid("entrance_id").references(() => entrances.id),
  apartment: text("apartment"),
  doorCodeEncrypted: text("door_code_encrypted"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("addresses_customer_idx").on(t.organizationId, t.customerId)]);
