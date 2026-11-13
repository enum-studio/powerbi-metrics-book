CREATE TABLE "request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via" text NOT NULL,
	"client_id" text,
	"question" text NOT NULL,
	"outcome" text NOT NULL,
	"gaps" text[] DEFAULT '{}' NOT NULL,
	"missing" text,
	"elements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_ids" uuid[] DEFAULT '{}' NOT NULL,
	"search_ids" uuid[] DEFAULT '{}' NOT NULL,
	"search_tsv" "tsvector",
	CONSTRAINT "request_principal_kind_check" CHECK ("request"."principal_kind" in ('person', 'service_account')),
	CONSTRAINT "request_via_check" CHECK ("request"."via" in ('browser', 'mcp', 'api', 'cli')),
	CONSTRAINT "request_outcome_check" CHECK ("request"."outcome" in ('answered', 'partly_answered', 'not_answered')),
	CONSTRAINT "request_outcome_gaps_check" CHECK ("request"."outcome" = 'answered' or cardinality("request"."gaps") > 0),
	CONSTRAINT "request_question_check" CHECK (char_length("request"."question") between 1 and 2000),
	CONSTRAINT "request_missing_check" CHECK ("request"."missing" is null or char_length("request"."missing") <= 2000),
	CONSTRAINT "request_gaps_check" CHECK ("request"."gaps" <@ array['no_metric', 'unclear_metric', 'wrong_definition', 'missing_description', 'missing_dimension', 'no_access', 'data_wrong', 'other']::text[]),
	CONSTRAINT "request_gaps_unique_check" CHECK (cardinality(array_positions("request"."gaps", 'no_metric')) <= 1 and cardinality(array_positions("request"."gaps", 'unclear_metric')) <= 1 and cardinality(array_positions("request"."gaps", 'wrong_definition')) <= 1 and cardinality(array_positions("request"."gaps", 'missing_description')) <= 1 and cardinality(array_positions("request"."gaps", 'missing_dimension')) <= 1 and cardinality(array_positions("request"."gaps", 'no_access')) <= 1 and cardinality(array_positions("request"."gaps", 'data_wrong')) <= 1 and cardinality(array_positions("request"."gaps", 'other')) <= 1),
	CONSTRAINT "request_query_ids_check" CHECK (cardinality("request"."query_ids") <= 20),
	CONSTRAINT "request_search_ids_check" CHECK (cardinality("request"."search_ids") <= 20),
	CONSTRAINT "request_elements_check" CHECK (jsonb_array_length("request"."elements") <= 20)
);
--> statement-breakpoint
CREATE TABLE "search_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via" text NOT NULL,
	"client_id" text,
	"query" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_mode" text NOT NULL,
	"hit_count" integer NOT NULL,
	"metric_hit" boolean NOT NULL,
	"top_hits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "search_log_principal_kind_check" CHECK ("search_log"."principal_kind" in ('person', 'service_account')),
	CONSTRAINT "search_log_via_check" CHECK ("search_log"."via" in ('mcp', 'cli', 'api')),
	CONSTRAINT "search_log_search_mode_check" CHECK ("search_log"."search_mode" in ('hybrid', 'words_only')),
	CONSTRAINT "search_log_query_check" CHECK (char_length("search_log"."query") <= 500),
	CONSTRAINT "search_log_hit_count_check" CHECK ("search_log"."hit_count" >= 0),
	CONSTRAINT "search_log_top_hits_check" CHECK (jsonb_array_length("search_log"."top_hits") <= 10),
	CONSTRAINT "search_log_filters_check" CHECK (jsonb_typeof("search_log"."filters") = 'object')
);
--> statement-breakpoint
ALTER TABLE "job_request" DROP CONSTRAINT "job_request_job";--> statement-breakpoint
ALTER TABLE "setting" DROP CONSTRAINT "setting_key_known";--> statement-breakpoint
CREATE INDEX "request_principal_idx" ON "request" USING btree ("principal_kind","principal_id","at");--> statement-breakpoint
CREATE INDEX "request_at_idx" ON "request" USING btree ("at");--> statement-breakpoint
CREATE INDEX "request_gaps_idx" ON "request" USING gin ("gaps");--> statement-breakpoint
CREATE INDEX "request_search_tsv_idx" ON "request" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "search_log_principal_idx" ON "search_log" USING btree ("principal_kind","principal_id","at");--> statement-breakpoint
CREATE INDEX "search_log_at_idx" ON "search_log" USING btree ("at");--> statement-breakpoint
ALTER TABLE "job_request" ADD CONSTRAINT "job_request_job" CHECK ("job_request"."job" in ('sync', 'expire_results', 'expire_usage', 'embed', 'rekey_tokens', 'refresh_idle_connections', 'check'));--> statement-breakpoint
ALTER TABLE "setting" ADD CONSTRAINT "setting_key_known" CHECK ("setting"."key" in ('usage.capture', 'usage.retention_days', 'powerbi.tenant_id', 'powerbi.app_client_id', 'powerbi.scanner_client_id', 'powerbi.authority', 'powerbi.api_url', 'powerbi.graph_url', 'powerbi.sync.schedule', 'powerbi.sync.full_scan_schedule', 'powerbi.sync.workspaces.include', 'powerbi.sync.workspaces.exclude', 'powerbi.sync.workspaces.personal', 'powerbi.datasets.new', 'powerbi.service_account_queries', 'powerbi.connection_requires_matching_email', 'powerbi.keep_connections_alive_days', 'access.metadata_visibility', 'access.default_role', 'sign_in.email_password', 'email.from', 'email.base_url', 'sign_in.providers', 'sign_in.passkeys', 'branding.name', 'branding.company', 'search.provider', 'search.model', 'search.base_url', 'results.ttl_hours', 'results.preview_rows', 'results.page_rows_max', 'results.daily_row_budget', 'queries.rate_per_minute', 'service_accounts.rate_per_minute', 'setup.completed_steps', 'setup.completed_at'));