CREATE TYPE "public"."adjustment_state" AS ENUM('proposed', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('delivered', 'recipient_unavailable', 'wrong_recipient', 'refused', 'partial', 'damaged');--> statement-breakpoint
CREATE TYPE "public"."batch_state" AS ENUM('created', 'processing', 'quality_check', 'packed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."claim_state" AS ENUM('opened', 'triage', 'investigating', 'decision_pending', 'resolved', 'denied_with_reason', 'escalated', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('open', 'investigating', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."evidence_state" AS ENUM('pending_upload', 'verified', 'quarantined', 'retained', 'legal_hold', 'expired');--> statement-breakpoint
CREATE TYPE "public"."fiscal_state" AS ENUM('not_created', 'pending_registration', 'registered', 'retry_pending', 'correction_requested', 'correction_pending', 'corrected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_state" AS ENUM('draft', 'posted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."manifest_mode" AS ENUM('economy_bag', 'protected_items', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."membership_state" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('draft', 'confirmed', 'scheduled', 'pickup_assigned', 'picked_up', 'at_hub', 'partner_received', 'inspection', 'awaiting_approval', 'processing', 'quality_check', 'ready', 'out_for_delivery', 'delivered', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_state" AS ENUM('pending', 'processing', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('pending', 'authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'disputed', 'chargeback_lost');--> statement-breakpoint
CREATE TYPE "public"."quote_state" AS ENUM('draft', 'active', 'accepted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."receipt_state" AS ENUM('expected', 'pending', 'accepted', 'discrepancy', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('held', 'confirmed', 'released', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('customer', 'courier', 'driver', 'hub_worker', 'laundry_operator', 'laundry_supervisor', 'partner_finance', 'dispatcher', 'customer_support', 'claims_investigator', 'claims_approver', 'platform_finance', 'platform_admin', 'security_auditor', 'system_worker');--> statement-breakpoint
CREATE TYPE "public"."route_stop_state" AS ENUM('pending', 'en_route', 'arrived', 'completed', 'failed', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."scan_sync_state" AS ENUM('pending', 'accepted', 'duplicate', 'rejected', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."seal_state" AS ENUM('available', 'assigned', 'broken', 'void');--> statement-breakpoint
CREATE TYPE "public"."shift_state" AS ENUM('planned', 'active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('economy', 'protected');--> statement-breakpoint
CREATE TYPE "public"."window_kind" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."window_status" AS ENUM('draft', 'open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_code" text NOT NULL,
	"label" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"role" "role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"partner_id" uuid,
	"state" "membership_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text,
	"display_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_org_code_unique" ON "devices" USING btree ("organization_id","device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_roles_unique" ON "membership_roles" USING btree ("membership_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_scope_unique" ON "memberships" USING btree ("organization_id","user_id","partner_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "partners_org_idx" ON "partners" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");