CREATE TABLE "customer_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"tariff_version_id" uuid,
	"tax_mode" text DEFAULT 'none' NOT NULL,
	"source" text DEFAULT 'quote' NOT NULL,
	"consent_id" uuid,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "customer_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"number" text NOT NULL,
	"total_kopeks" bigint NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"state" "fiscal_state" DEFAULT 'not_created' NOT NULL,
	"provider" text DEFAULT 'stub' NOT NULL,
	"provider_request_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_kopeks" bigint DEFAULT 0 NOT NULL,
	"credit_kopeks" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'RUB' NOT NULL,
	CONSTRAINT "ledger_entry_nonnegative" CHECK ("ledger_entries"."debit_kopeks" >= 0 AND "ledger_entries"."credit_kopeks" >= 0),
	CONSTRAINT "ledger_entry_single_side" CHECK (NOT ("ledger_entries"."debit_kopeks" > 0 AND "ledger_entries"."credit_kopeks" > 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"state" "ledger_state" DEFAULT 'posted' NOT NULL,
	"reversal_of" uuid,
	"description" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payment_intent_id" uuid,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'fake' NOT NULL,
	"provider_intent_id" text,
	"amount_kopeks" bigint NOT NULL,
	"state" "payment_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_invoice_lines_invoice_idx" ON "customer_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invoices_org_number_unique" ON "customer_invoices" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "fiscal_receipts_invoice_idx" ON "fiscal_receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_org_code_unique" ON "ledger_accounts" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_source_unique" ON "ledger_journals" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_org_key_unique" ON "payment_intents" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_org_key_unique" ON "refunds" USING btree ("organization_id","idempotency_key");