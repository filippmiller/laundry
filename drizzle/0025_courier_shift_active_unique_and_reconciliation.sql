CREATE TABLE "shift_reconciliation_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"scan_event_id" uuid NOT NULL,
	"delta_accepted" integer DEFAULT 0 NOT NULL,
	"delta_rejected" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_events" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
ALTER TABLE "courier_shifts" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_reconciliation_adjustments" ADD CONSTRAINT "shift_reconciliation_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_reconciliation_adjustments" ADD CONSTRAINT "shift_reconciliation_adjustments_shift_id_courier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."courier_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_reconciliation_adjustments" ADD CONSTRAINT "shift_reconciliation_adjustments_scan_event_id_scan_events_id_fk" FOREIGN KEY ("scan_event_id") REFERENCES "public"."scan_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_recon_adj_scan_unique" ON "shift_reconciliation_adjustments" USING btree ("scan_event_id");--> statement-breakpoint
CREATE INDEX "shift_recon_adj_shift_idx" ON "shift_reconciliation_adjustments" USING btree ("organization_id","shift_id","recorded_at");--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_shift_id_courier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."courier_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_events_shift_idx" ON "scan_events" USING btree ("organization_id","shift_id");--> statement-breakpoint
-- Safe deduplication: if pre-upgrade data contains multiple active shifts for the same
-- (organization_id, courier_id), close older duplicates while keeping the most recent active shift.
WITH ranked_active AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "organization_id", "courier_id"
			ORDER BY "created_at" DESC, "starts_at" DESC, "id" DESC
		) AS rn
	FROM "courier_shifts"
	WHERE "state" = 'active'
)
UPDATE "courier_shifts" cs
   SET "state" = 'completed',
       "completed_at" = COALESCE(cs."completed_at", now())
  FROM ranked_active ra
 WHERE cs."id" = ra."id"
   AND ra.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_shifts_org_courier_active_unique" ON "courier_shifts" USING btree ("organization_id","courier_id") WHERE "courier_shifts"."state" = 'active';