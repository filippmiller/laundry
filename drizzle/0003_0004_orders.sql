CREATE TABLE "customer_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"adjustment_id" uuid,
	"quote_hash" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"method" text NOT NULL,
	"evidence_ref" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"body_text" text NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"delta_kopeks" bigint NOT NULL,
	"state" "adjustment_state" DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"tier" "tier" NOT NULL,
	"quoted_quantity" integer NOT NULL,
	"actual_quantity" integer,
	"unit" text DEFAULT 'piece' NOT NULL,
	"quoted_amount_kopeks" bigint NOT NULL,
	"final_amount_kopeks" bigint,
	"tariff_snapshot_json" jsonb NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"public_number" text NOT NULL,
	"lifecycle_state" "order_state" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"terms_version" text NOT NULL,
	"accepted_quote_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tariff_version_id" uuid NOT NULL,
	"state" "quote_state" DEFAULT 'active' NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"quote_hash" text NOT NULL,
	"total_kopeks" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_approvals" ADD CONSTRAINT "customer_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_approvals" ADD CONSTRAINT "customer_approvals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_approvals" ADD CONSTRAINT "customer_approvals_adjustment_id_order_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."order_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_approvals" ADD CONSTRAINT "customer_approvals_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_adjustments" ADD CONSTRAINT "order_adjustments_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tariff_version_id_tariff_versions_id_fk" FOREIGN KEY ("tariff_version_id") REFERENCES "public"."tariff_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_order_idx" ON "customer_approvals" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_org_kind_version_unique" ON "document_versions" USING btree ("organization_id","kind","version");--> statement-breakpoint
CREATE INDEX "adjustments_order_idx" ON "order_adjustments" USING btree ("order_id","state");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_org_public_unique" ON "orders" USING btree ("organization_id","public_number");--> statement-breakpoint
CREATE INDEX "orders_org_customer_idx" ON "orders" USING btree ("organization_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_org_state_idx" ON "orders" USING btree ("organization_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "quotes_org_customer_idx" ON "quotes" USING btree ("organization_id","customer_id");