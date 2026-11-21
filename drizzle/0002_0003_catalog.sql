CREATE TABLE "partner_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"version" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"terms_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"version" text NOT NULL,
	"prices_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tariff_version_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"tier" "tier" NOT NULL,
	"unit_price_kopeks" bigint NOT NULL,
	"min_quantity" integer DEFAULT 1 NOT NULL,
	"rounding_rule" text DEFAULT 'gram_up_to_100' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"tier" "tier",
	"rule_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" text DEFAULT 'piece' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariff_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"terms_version" text NOT NULL,
	"off_schedule_pickup_kopeks" bigint DEFAULT 50000 NOT NULL,
	"off_schedule_delivery_kopeks" bigint DEFAULT 50000 NOT NULL,
	"shared_pickup_fee_kopeks" bigint DEFAULT 0 NOT NULL,
	"shared_delivery_fee_kopeks" bigint DEFAULT 0 NOT NULL,
	"quote_ttl_minutes" integer DEFAULT 30 NOT NULL,
	"hold_ttl_minutes" integer DEFAULT 10 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_price_versions" ADD CONSTRAINT "partner_price_versions_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tariff_version_id_tariff_versions_id_fk" FOREIGN KEY ("tariff_version_id") REFERENCES "public"."tariff_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_restrictions" ADD CONSTRAINT "service_restrictions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_plans" ADD CONSTRAINT "tariff_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_plan_id_tariff_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."tariff_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_contracts_partner_version_unique" ON "partner_contracts" USING btree ("partner_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_price_versions_contract_version_unique" ON "partner_price_versions" USING btree ("contract_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "price_rules_version_service_tier_unique" ON "price_rules" USING btree ("tariff_version_id","service_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_code_unique" ON "services" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_plans_org_code_unique" ON "tariff_plans" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_versions_plan_version_unique" ON "tariff_versions" USING btree ("plan_id","version");