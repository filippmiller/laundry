CREATE TABLE "garment_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"garment_id" uuid NOT NULL,
	"evidence_asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "containers" DROP CONSTRAINT "containers_code_unique";--> statement-breakpoint
ALTER TABLE "garment_evidence" ADD CONSTRAINT "garment_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_evidence" ADD CONSTRAINT "garment_evidence_garment_id_garments_id_fk" FOREIGN KEY ("garment_id") REFERENCES "public"."garments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garment_evidence" ADD CONSTRAINT "garment_evidence_evidence_asset_id_evidence_assets_id_fk" FOREIGN KEY ("evidence_asset_id") REFERENCES "public"."evidence_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "garment_evidence_garment_asset_unique" ON "garment_evidence" USING btree ("garment_id","evidence_asset_id");--> statement-breakpoint
CREATE INDEX "garment_evidence_org_garment_idx" ON "garment_evidence" USING btree ("organization_id","garment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "containers_org_code_unique" ON "containers" USING btree ("organization_id","code");