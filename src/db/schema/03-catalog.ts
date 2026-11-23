import { pgTable, uuid, text, bigint, integer, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, partners } from "./01-identity.js";
import { tierEnum } from "./enums.js";

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  unit: text("unit").notNull().default("piece"),
  active: boolean("active").notNull().default(true),
}, t => [uniqueIndex("services_org_code_unique").on(t.organizationId, t.code)]);

export const serviceRestrictions = pgTable("service_restrictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  tier: tierEnum("tier"),
  ruleJson: jsonb("rule_json").notNull(),
});

export const tariffPlans = pgTable("tariff_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
}, t => [uniqueIndex("tariff_plans_org_code_unique").on(t.organizationId, t.code)]);

export const tariffVersions = pgTable("tariff_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").notNull().references(() => tariffPlans.id),
  version: text("version").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  currency: text("currency").notNull().default("RUB"),
  termsVersion: text("terms_version").notNull(),
  offSchedulePickupKopeks: bigint("off_schedule_pickup_kopeks", { mode: "number" }).notNull().default(50000),
  offScheduleDeliveryKopeks: bigint("off_schedule_delivery_kopeks", { mode: "number" }).notNull().default(50000),
  sharedPickupFeeKopeks: bigint("shared_pickup_fee_kopeks", { mode: "number" }).notNull().default(0),
  sharedDeliveryFeeKopeks: bigint("shared_delivery_fee_kopeks", { mode: "number" }).notNull().default(0),
  quoteTtlMinutes: integer("quote_ttl_minutes").notNull().default(30),
  holdTtlMinutes: integer("hold_ttl_minutes").notNull().default(10),
  published: boolean("published").notNull().default(false),
  snapshotJson: jsonb("snapshot_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("tariff_versions_plan_version_unique").on(t.planId, t.version)]);

export const priceRules = pgTable("price_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tariffVersionId: uuid("tariff_version_id").notNull().references(() => tariffVersions.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  tier: tierEnum("tier").notNull(),
  unitPriceKopeks: bigint("unit_price_kopeks", { mode: "number" }).notNull(),
  minQuantity: integer("min_quantity").notNull().default(1),
  roundingRule: text("rounding_rule").notNull().default("gram_up_to_100"),
  active: boolean("active").notNull().default(true),
}, t => [uniqueIndex("price_rules_version_service_tier_unique").on(t.tariffVersionId, t.serviceId, t.tier)]);

export const partnerContracts = pgTable("partner_contracts", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  version: text("version").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  termsJson: jsonb("terms_json").notNull().default({}),
  signed: boolean("signed").notNull().default(false),
}, t => [uniqueIndex("partner_contracts_partner_version_unique").on(t.partnerId, t.version)]);

export const partnerPriceVersions = pgTable("partner_price_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: uuid("contract_id").notNull().references(() => partnerContracts.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  pricesJson: jsonb("prices_json").notNull().default({}),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
}, t => [uniqueIndex("partner_price_versions_contract_version_unique").on(t.contractId, t.version)]);
