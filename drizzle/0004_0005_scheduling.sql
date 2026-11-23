CREATE TABLE "service_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"kind" "window_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"is_shared" boolean DEFAULT true NOT NULL,
	"status" "window_status" DEFAULT 'open' NOT NULL,
	"capacity_orders" integer NOT NULL,
	"reserved_orders" integer DEFAULT 0 NOT NULL,
	"capacity_weight_grams" integer DEFAULT 0 NOT NULL,
	"reserved_weight_grams" integer DEFAULT 0 NOT NULL,
	"safety_buffer_orders" integer DEFAULT 0 NOT NULL,
	"fee_kopeks" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "window_time_order" CHECK ("service_windows"."ends_at" > "service_windows"."starts_at"),
	CONSTRAINT "window_capacity_nonnegative" CHECK ("service_windows"."capacity_orders" >= 0 AND "service_windows"."reserved_orders" >= 0 AND "service_windows"."reserved_orders" <= "service_windows"."capacity_orders"),
	CONSTRAINT "window_weight_nonnegative" CHECK ("service_windows"."capacity_weight_grams" >= 0 AND "service_windows"."reserved_weight_grams" >= 0 AND "service_windows"."reserved_weight_grams" <= "service_windows"."capacity_weight_grams"),
	CONSTRAINT "window_fee_nonnegative" CHECK ("service_windows"."fee_kopeks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "slot_exception_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"window_id" uuid,
	"kind" "window_kind" NOT NULL,
	"fee_kopeks" bigint NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"quote_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'quoted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_exception_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"reservation_id" uuid,
	"actor_id" uuid NOT NULL,
	"state" text DEFAULT 'awaiting_consent' NOT NULL,
	"payment_intent_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"order_id" uuid,
	"quote_id" uuid,
	"principal_id" uuid NOT NULL,
	"state" "reservation_state" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"capacity_units" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_windows" ADD CONSTRAINT "service_windows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_windows" ADD CONSTRAINT "service_windows_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_quotes" ADD CONSTRAINT "slot_exception_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_quotes" ADD CONSTRAINT "slot_exception_quotes_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_quotes" ADD CONSTRAINT "slot_exception_quotes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_quotes" ADD CONSTRAINT "slot_exception_quotes_window_id_service_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."service_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_requests" ADD CONSTRAINT "slot_exception_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_requests" ADD CONSTRAINT "slot_exception_requests_quote_id_slot_exception_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."slot_exception_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_requests" ADD CONSTRAINT "slot_exception_requests_reservation_id_slot_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."slot_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_exception_requests" ADD CONSTRAINT "slot_exception_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_window_id_service_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."service_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "windows_org_building_idx" ON "service_windows" USING btree ("organization_id","building_id","kind");--> statement-breakpoint
CREATE INDEX "windows_status_time_idx" ON "service_windows" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "exception_quotes_customer_idx" ON "slot_exception_quotes" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_window_idempotency_unique" ON "slot_reservations" USING btree ("window_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "slot_reservations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "reservations_window_state_idx" ON "slot_reservations" USING btree ("window_id","state");