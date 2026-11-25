CREATE TABLE "support_message_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_message_drafts" ADD CONSTRAINT "support_message_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message_drafts" ADD CONSTRAINT "support_message_drafts_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message_drafts" ADD CONSTRAINT "support_message_drafts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_message_drafts_thread_author_unique" ON "support_message_drafts" USING btree ("thread_id","author_id");--> statement-breakpoint
CREATE INDEX "support_message_drafts_thread_idx" ON "support_message_drafts" USING btree ("thread_id");--> statement-breakpoint
-- Keyset pagination for the partner dispute list filters on the tenant and the dispute state.
-- The table lives in `src/db/schema/11-partner-finance.ts`, which this wave does not own, so the
-- index is added here instead of through `drizzle-kit generate`.
CREATE INDEX "partner_disputes_org_state_idx" ON "partner_disputes" USING btree ("organization_id","state");
