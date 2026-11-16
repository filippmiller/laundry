CREATE TABLE "custody_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "dispute_state" DEFAULT 'open' NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"container_id" uuid,
	"from_party" text NOT NULL,
	"to_party" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"manifest_id" uuid,
	"manifest_hash" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"purpose" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone,
	"legal_hold_count" integer DEFAULT 0 NOT NULL,
	"status" "evidence_state" DEFAULT 'pending_upload' NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "evidence_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"claim_id" uuid,
	"reason" text NOT NULL,
	"placed_by" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"client_event_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"scanned_type" text NOT NULL,
	"scanned_id" text NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_hash" text NOT NULL,
	"sync_status" "scan_sync_state" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custody_discrepancies" ADD CONSTRAINT "custody_discrepancies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_discrepancies" ADD CONSTRAINT "custody_discrepancies_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_discrepancies" ADD CONSTRAINT "custody_discrepancies_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_access_events" ADD CONSTRAINT "evidence_access_events_asset_id_evidence_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."evidence_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_access_events" ADD CONSTRAINT "evidence_access_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD CONSTRAINT "evidence_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD CONSTRAINT "evidence_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_legal_holds" ADD CONSTRAINT "evidence_legal_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_legal_holds" ADD CONSTRAINT "evidence_legal_holds_asset_id_evidence_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."evidence_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_legal_holds" ADD CONSTRAINT "evidence_legal_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custody_discrepancies_order_idx" ON "custody_discrepancies" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "custody_events_order_time_idx" ON "custody_events" USING btree ("organization_id","order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "custody_events_container_time_idx" ON "custody_events" USING btree ("container_id","occurred_at");--> statement-breakpoint
CREATE INDEX "evidence_access_asset_idx" ON "evidence_access_events" USING btree ("asset_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_object_key_unique" ON "evidence_assets" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "evidence_owner_idx" ON "evidence_assets" USING btree ("organization_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "evidence_holds_asset_idx" ON "evidence_legal_holds" USING btree ("asset_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_events_device_client_unique" ON "scan_events" USING btree ("device_id","client_event_id");--> statement-breakpoint
CREATE INDEX "scan_events_actor_idx" ON "scan_events" USING btree ("organization_id","actor_id","captured_at");