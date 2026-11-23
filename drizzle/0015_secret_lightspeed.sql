ALTER TABLE "payment_events" ADD COLUMN "state" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "payment_events_inbox_idx" ON "payment_events" USING btree ("state","received_at");