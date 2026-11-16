CREATE TABLE "partner_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"original_line_id" uuid,
	"amount_kopeks" bigint NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" "dispute_state" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"accrual_id" uuid NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_kopeks" bigint NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_credit_notes" ADD CONSTRAINT "partner_credit_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_notes" ADD CONSTRAINT "partner_credit_notes_invoice_id_partner_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."partner_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_notes" ADD CONSTRAINT "partner_credit_notes_original_line_id_partner_invoice_lines_id_fk" FOREIGN KEY ("original_line_id") REFERENCES "public"."partner_invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_notes" ADD CONSTRAINT "partner_credit_notes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_disputes" ADD CONSTRAINT "partner_disputes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_disputes" ADD CONSTRAINT "partner_disputes_invoice_line_id_partner_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."partner_invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_disputes" ADD CONSTRAINT "partner_disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invoice_lines" ADD CONSTRAINT "partner_invoice_lines_invoice_id_partner_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."partner_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invoice_lines" ADD CONSTRAINT "partner_invoice_lines_accrual_id_partner_service_accruals_id_fk" FOREIGN KEY ("accrual_id") REFERENCES "public"."partner_service_accruals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invoices" ADD CONSTRAINT "partner_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_invoices" ADD CONSTRAINT "partner_invoices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_disputes_line_idx" ON "partner_disputes" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX "partner_invoice_lines_invoice_idx" ON "partner_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_invoices_org_number_unique" ON "partner_invoices" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "partner_payouts_partner_idx" ON "partner_payouts" USING btree ("organization_id","partner_id");