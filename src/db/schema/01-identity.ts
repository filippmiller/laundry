import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { membershipState, roleEnum } from "./enums.js";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").unique(),
  displayName: text("display_name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partners = pgTable("partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("partners_org_idx").on(t.organizationId)]);

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  partnerId: uuid("partner_id").references(() => partners.id),
  state: membershipState("state").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("memberships_scope_unique").on(t.organizationId, t.userId, t.partnerId),
  index("memberships_user_idx").on(t.userId),
]);

export const membershipRoles = pgTable("membership_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull(),
}, t => [uniqueIndex("membership_roles_unique").on(t.membershipId, t.role)]);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  deviceCode: text("device_code").notNull(),
  label: text("label"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("devices_org_code_unique").on(t.organizationId, t.deviceCode)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("sessions_user_idx").on(t.userId)]);
