import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, partners, users } from "./01-identity.js";
import { partnerServiceAccruals } from "./08-processing.js";
import { disputeState } from "./enums.js";

export const partnerInvoices = pgTable("partner_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  number: text("number").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  totalKopeks: bigint("total_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("partner_invoices_org_number_unique").on(t.organizationId, t.number)]);

export const partnerInvoiceLines = pgTable("partner_invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull().references(() => partnerInvoices.id, { onDelete: "cascade" }),
  accrualId: uuid("accrual_id").notNull().references(() => partnerServiceAccruals.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("pending"),
}, t => [index("partner_invoice_lines_invoice_idx").on(t.invoiceId)]);

export const partnerDisputes = pgTable("partner_disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  invoiceLineId: uuid("invoice_line_id").notNull().references(() => partnerInvoiceLines.id),
  openedBy: uuid("opened_by").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  state: disputeState("state").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("partner_disputes_line_idx").on(t.invoiceLineId)]);

export const partnerCreditNotes = pgTable("partner_credit_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  invoiceId: uuid("invoice_id").notNull().references(() => partnerInvoices.id),
  originalLineId: uuid("original_line_id").references(() => partnerInvoiceLines.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("draft"),
  approvedBy: uuid("approved_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const partnerPayouts = pgTable("partner_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  partnerId: uuid("partner_id").notNull().references(() => partners.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("scheduled"),
  reference: text("reference"),
  createdBy: uuid("created_by").references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("partner_payouts_partner_idx").on(t.organizationId, t.partnerId)]);
