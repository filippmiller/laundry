ALTER TYPE "public"."outbox_state" ADD VALUE 'dead_letter';--> statement-breakpoint
ALTER TABLE "buildings" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "buildings" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "evidence_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "delivery_status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "provider_receipt" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;