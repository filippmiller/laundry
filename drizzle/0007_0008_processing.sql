CREATE TABLE "batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"garment_id" uuid,
	"order_line_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"process_type" text NOT NULL,
	"state" "batch_state" DEFAULT 'created' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"expected_seal_id" uuid,
	"actual_seal_id" uuid,
	"expected_weight_grams" integer,
	"actual_weight_grams" integer,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"manifest_id" uuid,
	"discrepancy_id" uuid,
	"expected_hash" text NOT NULL,
	"actual_hash" text,
	"state" "receipt_state" DEFAULT 'expected' NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "partner_service_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_price_version_id" uuid,
	"quantity" integer NOT NULL,
	"amount_kopeks" bigint NOT NULL,
	"status" text DEFAULT 'estimated' NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"batch_item_id" uuid,
	"operation" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"garment_id" uuid,
	"result" text NOT NULL,
	"note" text,
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipt_lines" ADD CONSTRAINT "partner_receipt_lines_receipt_id_partner_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."partner_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipt_lines" ADD CONSTRAINT "partner_receipt_lines_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipt_lines" ADD CONSTRAINT "partner_receipt_lines_expected_seal_id_seals_id_fk" FOREIGN KEY ("expected_seal_id") REFERENCES "public"."seals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipt_lines" ADD CONSTRAINT "partner_receipt_lines_actual_seal_id_seals_id_fk" FOREIGN KEY ("actual_seal_id") REFERENCES "public"."seals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_manifest_id_intake_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."intake_manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_discrepancy_id_custody_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."custody_discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_receipts" ADD CONSTRAINT "partner_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service_accruals" ADD CONSTRAINT "partner_service_accruals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service_accruals" ADD CONSTRAINT "partner_service_accruals_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service_accruals" ADD CONSTRAINT "partner_service_accruals_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service_accruals" ADD CONSTRAINT "partner_service_accruals_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_service_accruals" ADD CONSTRAINT "partner_service_accruals_contract_price_version_id_partner_price_versions_id_fk" FOREIGN KEY ("contract_price_version_id") REFERENCES "public"."partner_price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_batch_item_id_batch_items_id_fk" FOREIGN KEY ("batch_item_id") REFERENCES "public"."batch_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_items_unique" ON "batch_items" USING btree ("batch_id","garment_id","order_line_id");--> statement-breakpoint
CREATE INDEX "batches_partner_idx" ON "batches" USING btree ("organization_id","partner_id","state");--> statement-breakpoint
CREATE INDEX "receipt_lines_receipt_idx" ON "partner_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "partner_receipts_partner_idx" ON "partner_receipts" USING btree ("organization_id","partner_id","state");--> statement-breakpoint
CREATE INDEX "accruals_partner_status_idx" ON "partner_service_accruals" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "processing_ops_batch_idx" ON "processing_operations" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "quality_checks_order_idx" ON "quality_checks" USING btree ("organization_id","order_id");