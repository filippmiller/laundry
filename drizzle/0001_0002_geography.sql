CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"zone_id" uuid,
	"address" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"access_notes" text,
	"active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"active" text DEFAULT 'true' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"entrance_id" uuid,
	"apartment" text,
	"door_code_encrypted" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entrances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"building_id" uuid NOT NULL,
	"label" text NOT NULL,
	"access_code_hash" text
);
--> statement-breakpoint
CREATE TABLE "service_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"name" text NOT NULL,
	"polygon_json" text
);
--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_zone_id_service_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."service_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_entrance_id_entrances_id_fk" FOREIGN KEY ("entrance_id") REFERENCES "public"."entrances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrances" ADD CONSTRAINT "entrances_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_zones" ADD CONSTRAINT "service_zones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_zones" ADD CONSTRAINT "service_zones_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buildings_org_address_unique" ON "buildings" USING btree ("organization_id","address");--> statement-breakpoint
CREATE INDEX "buildings_org_idx" ON "buildings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cities_org_name_unique" ON "cities" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "customer_addresses" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entrances_building_label_unique" ON "entrances" USING btree ("building_id","label");--> statement-breakpoint
CREATE INDEX "zones_city_idx" ON "service_zones" USING btree ("city_id");