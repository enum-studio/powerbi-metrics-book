CREATE TABLE "conventions_preset" (
	"name" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_edge" (
	"parent_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"sign" integer DEFAULT 1 NOT NULL,
	"operation" text DEFAULT 'sum' NOT NULL,
	"note" text,
	CONSTRAINT "metric_edge_parent_id_child_id_pk" PRIMARY KEY("parent_id","child_id"),
	CONSTRAINT "metric_edge_self_check" CHECK ("metric_edge"."parent_id" <> "metric_edge"."child_id"),
	CONSTRAINT "metric_edge_sign_check" CHECK ("metric_edge"."sign" in (-1, 1)),
	CONSTRAINT "metric_edge_operation_check" CHECK ("metric_edge"."operation" in ('sum', 'product'))
);
--> statement-breakpoint
CREATE TABLE "metric_follow" (
	"person_id" text NOT NULL,
	"metric_id" uuid NOT NULL,
	CONSTRAINT "metric_follow_person_id_metric_id_pk" PRIMARY KEY("person_id","metric_id")
);
--> statement-breakpoint
CREATE TABLE "metric_link" (
	"metric_id" uuid NOT NULL,
	"other_metric_id" uuid NOT NULL,
	"movement" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"other_reason" text DEFAULT '' NOT NULL,
	CONSTRAINT "metric_link_metric_id_other_metric_id_pk" PRIMARY KEY("metric_id","other_metric_id"),
	CONSTRAINT "metric_link_order_check" CHECK ("metric_link"."metric_id" < "metric_link"."other_metric_id"),
	CONSTRAINT "metric_link_movement_check" CHECK ("metric_link"."movement" in ('same', 'opposite', 'depends')),
	CONSTRAINT "metric_link_reason_check" CHECK (btrim("metric_link"."reason") <> '' or btrim("metric_link"."other_reason") <> '')
);
--> statement-breakpoint
CREATE TABLE "person_profile" (
	"person_id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setting" DROP CONSTRAINT "setting_key_known";--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "kicker" text;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "tier" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "importance" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "direction" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "importance_why" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "use_for" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "dont_use_for" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "caveats" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "decisions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "actions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "owner_team" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "primary_dimensions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "building_block" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "owner_person" text;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "owner_person_name" text;--> statement-breakpoint
ALTER TABLE "metric" ADD COLUMN "owner_person_title" text;--> statement-breakpoint
ALTER TABLE "term" ADD COLUMN "group" text;--> statement-breakpoint
ALTER TABLE "metric_edge" ADD CONSTRAINT "metric_edge_parent_id_metric_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."metric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_edge" ADD CONSTRAINT "metric_edge_child_id_metric_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."metric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_follow" ADD CONSTRAINT "metric_follow_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_follow" ADD CONSTRAINT "metric_follow_metric_id_metric_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metric"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_link" ADD CONSTRAINT "metric_link_metric_id_metric_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_link" ADD CONSTRAINT "metric_link_other_metric_id_metric_id_fk" FOREIGN KEY ("other_metric_id") REFERENCES "public"."metric"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_profile" ADD CONSTRAINT "person_profile_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric" ADD CONSTRAINT "metric_owner_person_user_id_fk" FOREIGN KEY ("owner_person") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting" ADD CONSTRAINT "setting_key_known" CHECK ("setting"."key" in ('guide.enabled', 'guide.result_metric', 'guide.featured_metric', 'exports.markdown', 'exports.pdf', 'questions.enabled', 'usage.capture', 'usage.retention_days', 'powerbi.tenant_id', 'powerbi.app_client_id', 'powerbi.scanner_client_id', 'powerbi.authority', 'powerbi.api_url', 'powerbi.graph_url', 'powerbi.sync.schedule', 'powerbi.sync.full_scan_schedule', 'powerbi.sync.workspaces.include', 'powerbi.sync.workspaces.exclude', 'powerbi.sync.workspaces.personal', 'powerbi.datasets.new', 'powerbi.service_account_queries', 'powerbi.connection_requires_matching_email', 'powerbi.keep_connections_alive_days', 'access.metadata_visibility', 'access.default_role', 'sign_in.email_password', 'email.from', 'email.base_url', 'sign_in.providers', 'sign_in.passkeys', 'branding.name', 'branding.company', 'search.provider', 'search.model', 'search.base_url', 'results.ttl_hours', 'results.preview_rows', 'results.page_rows_max', 'results.daily_row_budget', 'queries.rate_per_minute', 'service_accounts.rate_per_minute', 'setup.completed_steps', 'setup.completed_at'));