ALTER TABLE "partner_credit_notes" ADD COLUMN "dispute_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_credit_notes" ADD CONSTRAINT "partner_credit_notes_dispute_id_partner_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."partner_disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH ranked_open_disputes AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "invoice_line_id"
			ORDER BY "opened_at" DESC, "id" DESC
		) AS rn
	FROM "partner_disputes"
	WHERE "state" IN ('open', 'investigating')
)
UPDATE "partner_disputes" pd
   SET "state" = 'resolved'
  FROM ranked_open_disputes rod
 WHERE pd."id" = rod."id"
   AND rod.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_disputes_one_open_per_line_unique" ON "partner_disputes" USING btree ("invoice_line_id") WHERE "partner_disputes"."state" IN ('open', 'investigating');--> statement-breakpoint
INSERT INTO "evidence_legal_holds" ("organization_id", "asset_id", "claim_id", "reason", "placed_by")
SELECT
	ea."organization_id",
	ea."id",
	c."id",
	'backfill_active_claim_direct_attachment',
	COALESCE(ea."created_by", c."opened_by")
FROM "evidence_assets" ea
JOIN "claims" c
  ON c."id" = ea."owner_id"
 AND c."organization_id" = ea."organization_id"
WHERE ea."owner_type" = 'claim'
  AND ea."deleted_at" IS NULL
  AND ea."status" IN ('verified', 'retained')
  AND c."state" IN ('opened', 'triage', 'investigating', 'decision_pending', 'escalated', 'reopened')
  AND NOT EXISTS (
	SELECT 1
	FROM "evidence_legal_holds" h
	WHERE h."asset_id" = ea."id"
	  AND h."released_at" IS NULL
  );
