CREATE TABLE "courier_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"courier_id" uuid NOT NULL,
	"label" text DEFAULT 'courier device' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "courier_devices" ADD CONSTRAINT "courier_devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_devices" ADD CONSTRAINT "courier_devices_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_devices_org_courier_unique" ON "courier_devices" USING btree ("organization_id","courier_id","id");--> statement-breakpoint
CREATE INDEX "courier_devices_org_state_idx" ON "courier_devices" USING btree ("organization_id","state");