CREATE TABLE "container_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seal_id" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text DEFAULT 'bag' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "containers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "garment_container_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"garment_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "garments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid,
	"item_code" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"brand_mark" text,
	"declared_value_kopeks" bigint,
	"condition_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'declared' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garments_item_code_unique" UNIQUE("item_code")
);
--> statement-breakpoint
CREATE TABLE "intake_manifest_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manifest_id" uuid NOT NULL,
	"garment_id" uuid,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"weight_grams" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"container_id" uuid,
	"mode" "manifest_mode" NOT NULL,
	"count" integer NOT NULL,
	"weight_grams" integer DEFAULT 0 NOT NULL,
	"manifest_hash" text NOT NULL,
	"customer_confirmation_id" uuid,
	"courier_confirmation_id" uuid,
	"state" text DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"state" "seal_state" DEFAULT 'available' NOT NULL,
	CONSTRAINT "seals_serial_number_unique" UNIQUE("serial_number")
);
--> statement-breakpoint
ALTER TABLE "container_assignments" ADD CONSTRAINT "container_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_assignments" ADD CONSTRAINT "container_assignments_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_assignments" ADD CONSTRAINT "container_assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_assignments" ADD CONSTRAINT "container_assignments_seal_id_seals_id_fk" FOREIGN KEY ("seal_id") REFERENCES "public"."seals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_container_events" ADD CONSTRAINT "garment_container_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_container_events" ADD CONSTRAINT "garment_container_events_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_container_events" ADD CONSTRAINT "garment_container_events_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_container_events" ADD CONSTRAINT "garment_container_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garments" ADD CONSTRAINT "garments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garments" ADD CONSTRAINT "garments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garments" ADD CONSTRAINT "garments_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifest_lines" ADD CONSTRAINT "intake_manifest_lines_manifest_id_intake_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."intake_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifest_lines" ADD CONSTRAINT "intake_manifest_lines_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifests" ADD CONSTRAINT "intake_manifests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifests" ADD CONSTRAINT "intake_manifests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifests" ADD CONSTRAINT "intake_manifests_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifests" ADD CONSTRAINT "intake_manifests_customer_confirmation_id_users_id_fk" FOREIGN KEY ("customer_confirmation_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_manifests" ADD CONSTRAINT "intake_manifests_courier_confirmation_id_users_id_fk" FOREIGN KEY ("courier_confirmation_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seals" ADD CONSTRAINT "seals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_assignments_order_idx" ON "container_assignments" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "containers_org_idx" ON "containers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "garment_container_events_garment_idx" ON "garment_container_events" USING btree ("garment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "garments_order_idx" ON "garments" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "manifest_lines_manifest_idx" ON "intake_manifest_lines" USING btree ("manifest_id");--> statement-breakpoint
CREATE INDEX "manifests_order_idx" ON "intake_manifests" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "seals_org_idx" ON "seals" USING btree ("organization_id");