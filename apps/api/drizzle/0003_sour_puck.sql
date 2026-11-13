CREATE TABLE "person_deactivation" (
	"user_id" text PRIMARY KEY NOT NULL,
	"deactivated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_logo" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_logo_single_row" CHECK ("brand_logo"."id"),
	CONSTRAINT "brand_logo_content_type" CHECK ("brand_logo"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "brand_logo_size" CHECK (octet_length("brand_logo"."bytes") <= 262144),
	CONSTRAINT "brand_logo_digest" CHECK ("brand_logo"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "setting" DROP CONSTRAINT "setting_key_known";--> statement-breakpoint
DROP INDEX "invite_open_email";--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "delivery" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "accepted_user_id" text;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "person_deactivation" ADD CONSTRAINT "person_deactivation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_accepted_user_id_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invite_open_email" ON "invite" USING btree ("email") WHERE "invite"."used_at" is null and "invite"."accepted_at" is null and "invite"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "setting" ADD CONSTRAINT "setting_key_known" CHECK ("setting"."key" in ('powerbi.tenant_id', 'powerbi.app_client_id', 'powerbi.scanner_client_id', 'powerbi.authority', 'powerbi.api_url', 'powerbi.graph_url', 'powerbi.sync.schedule', 'powerbi.sync.full_scan_schedule', 'powerbi.sync.workspaces.include', 'powerbi.sync.workspaces.exclude', 'powerbi.sync.workspaces.personal', 'powerbi.datasets.new', 'powerbi.service_account_queries', 'powerbi.connection_requires_matching_email', 'powerbi.keep_connections_alive_days', 'access.metadata_visibility', 'access.default_role', 'sign_in.email_password', 'email.from', 'email.base_url', 'sign_in.providers', 'sign_in.passkeys', 'branding.name', 'branding.company', 'search.provider', 'search.model', 'search.base_url', 'results.ttl_hours', 'results.preview_rows', 'results.page_rows_max', 'results.daily_row_budget', 'queries.rate_per_minute', 'service_accounts.rate_per_minute', 'setup.completed_steps', 'setup.completed_at'));--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_role" CHECK ("invite"."role" ~ '^[a-z][a-z0-9_]*$' and "invite"."role" <> 'none');--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_delivery" CHECK ("invite"."delivery" in ('email', 'link'));--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_accepted_or_revoked" CHECK ("invite"."accepted_at" is null or "invite"."revoked_at" is null);