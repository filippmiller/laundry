import { pgTable, uuid, text, bigint, integer, timestamp, check, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users } from "./01-identity.js";
import { orders } from "./04-orders.js";
import { paymentState, fiscalState, ledgerState } from "./enums.js";

export const customerInvoices = pgTable("customer_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  number: text("number").notNull(),
  totalKopeks: bigint("total_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("customer_invoices_org_number_unique").on(t.organizationId, t.number)]);

export const customerInvoiceLines = pgTable("customer_invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull().references(() => customerInvoices.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull().default(1),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  tariffVersionId: uuid("tariff_version_id"),
  taxMode: text("tax_mode").notNull().default("none"),
  source: text("source").notNull().default("quote"),
  consentId: uuid("consent_id"),
  actorId: uuid("actor_id").references(() => users.id),
}, t => [index("customer_invoice_lines_invoice_idx").on(t.invoiceId)]);

export const paymentIntents = pgTable("payment_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  provider: text("provider").notNull().default("fake"),
  providerIntentId: text("provider_intent_id"),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  state: paymentState("state").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("payment_intents_org_key_unique").on(t.organizationId, t.idempotencyKey)]);

export const paymentEvents = pgTable("payment_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  paymentIntentId: uuid("payment_intent_id").references(() => paymentIntents.id),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  state: text("state").notNull().default("received"),
  attempts: integer("attempts").notNull().default(0),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("payment_events_provider_event_unique").on(t.provider, t.providerEventId),
  index("payment_events_inbox_idx").on(t.state, t.receivedAt),
]);

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  paymentIntentId: uuid("payment_intent_id").notNull().references(() => paymentIntents.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  state: text("state").notNull().default("pending"),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("refunds_org_key_unique").on(t.organizationId, t.idempotencyKey)]);

export const fiscalReceipts = pgTable("fiscal_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  invoiceId: uuid("invoice_id").notNull().references(() => customerInvoices.id),
  state: fiscalState("state").notNull().default("not_created"),
  provider: text("provider").notNull().default("stub"),
  providerRequestId: text("provider_request_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("fiscal_receipts_invoice_idx").on(t.invoiceId)]);

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("RUB"),
}, t => [uniqueIndex("ledger_accounts_org_code_unique").on(t.organizationId, t.code)]);

export const ledgerJournals = pgTable("ledger_journals", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  state: ledgerState("state").notNull().default("posted"),
  reversalOf: uuid("reversal_of"),
  description: text("description").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("ledger_journals_source_unique").on(t.organizationId, t.sourceType, t.sourceId)]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  journalId: uuid("journal_id").notNull().references(() => ledgerJournals.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  debitKopeks: bigint("debit_kopeks", { mode: "number" }).notNull().default(0),
  creditKopeks: bigint("credit_kopeks", { mode: "number" }).notNull().default(0),
  currency: text("currency").notNull().default("RUB"),
}, t => [
  check("ledger_entry_nonnegative", sql`${t.debitKopeks} >= 0 AND ${t.creditKopeks} >= 0`),
  check("ledger_entry_single_side", sql`NOT (${t.debitKopeks} > 0 AND ${t.creditKopeks} > 0)`),
  index("ledger_entries_journal_idx").on(t.journalId),
]);
