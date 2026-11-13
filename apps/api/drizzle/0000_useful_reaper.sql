CREATE TABLE "audit_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via" text NOT NULL,
	"client_id" text,
	"action" text NOT NULL,
	"resource_kind" text,
	"resource_id" text,
	"decision" text NOT NULL,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_event_decision" CHECK ("audit_event"."decision" in ('allow', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "job_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"runner" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	CONSTRAINT "job_request_job" CHECK ("job_request"."job" in ('sync', 'expire_results', 'embed', 'rekey_tokens', 'refresh_idle_connections', 'check')),
	CONSTRAINT "job_request_runner" CHECK ("job_request"."runner" in ('worker', 'api')),
	CONSTRAINT "job_request_trigger" CHECK ("job_request"."trigger" in ('schedule', 'manual', 'deploy')),
	CONSTRAINT "job_request_status" CHECK ("job_request"."status" in ('queued', 'running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "person_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"microsoft_object_id" uuid,
	"group_object_ids" uuid[] DEFAULT '{}' NOT NULL,
	"groups_read_at" timestamp with time zone,
	CONSTRAINT "person_identity_microsoft_object_id_unique" UNIQUE("microsoft_object_id")
);
--> statement-breakpoint
CREATE TABLE "powerbi_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_object_id" uuid NOT NULL,
	"email" text,
	"access_right" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "powerbi_access_object_principal_key" UNIQUE("object_kind","object_id","principal_type","principal_object_id"),
	CONSTRAINT "powerbi_access_object_kind_check" CHECK ("powerbi_access"."object_kind" in ('workspace', 'app', 'dataset')),
	CONSTRAINT "powerbi_access_principal_type_check" CHECK ("powerbi_access"."principal_type" in ('user', 'group', 'app'))
);
--> statement-breakpoint
CREATE TABLE "powerbi_app" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description_pbi" text,
	"workspace_id" uuid NOT NULL,
	"published_by" text,
	"last_update" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_app_custom_check" CHECK (jsonb_typeof("powerbi_app"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_app_dataset" (
	"app_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	CONSTRAINT "powerbi_app_dataset_app_id_dataset_id_pk" PRIMARY KEY("app_id","dataset_id")
);
--> statement-breakpoint
CREATE TABLE "powerbi_column" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"data_type" text,
	"column_type" text,
	"expression" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"format_string" text,
	"description_pbi" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_column_table_id_name_key" UNIQUE("table_id","name"),
	CONSTRAINT "powerbi_column_column_type_check" CHECK ("powerbi_column"."column_type" in ('data', 'calculated', 'calculated_table_column', 'row_number')),
	CONSTRAINT "powerbi_column_custom_check" CHECK (jsonb_typeof("powerbi_column"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_dataset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description_pbi" text,
	"configured_by" text,
	"target_storage_mode" text,
	"has_row_level_security" boolean DEFAULT false NOT NULL,
	"endorsement" text,
	"sensitivity_label" text,
	"schema_error" text,
	"relationships_source" text,
	"relationships_read_at" timestamp with time zone,
	"schema_changed_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_date" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_dataset_relationships_source_check" CHECK ("powerbi_dataset"."relationships_source" in ('scanner', 'info_view', 'unavailable')),
	CONSTRAINT "powerbi_dataset_custom_check" CHECK (jsonb_typeof("powerbi_dataset"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_measure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"expression" text,
	"normalized_expression" text,
	"fingerprint" text,
	"fingerprint_error" text,
	"format_string" text,
	"display_folder" text,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"description_pbi" text,
	"expression_changed_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_measure_dataset_id_name_key" UNIQUE("dataset_id","name"),
	CONSTRAINT "powerbi_measure_custom_check" CHECK (jsonb_typeof("powerbi_measure"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"from_table" text NOT NULL,
	"from_column" text NOT NULL,
	"to_table" text NOT NULL,
	"to_column" text NOT NULL,
	"cardinality" text,
	"cross_filtering_behavior" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_relationship_custom_check" CHECK (jsonb_typeof("powerbi_relationship"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_table" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"description_pbi" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_table_dataset_id_name_key" UNIQUE("dataset_id","name"),
	CONSTRAINT "powerbi_table_custom_check" CHECK (jsonb_typeof("powerbi_table"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "powerbi_workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"state" text,
	"is_on_dedicated_capacity" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"description" text,
	"described_by" text,
	"described_at" timestamp with time zone,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "powerbi_workspace_custom_check" CHECK (jsonb_typeof("powerbi_workspace"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"workspaces_scanned" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "sync_run_kind_check" CHECK ("sync_run"."kind" in ('incremental', 'full')),
	CONSTRAINT "sync_run_trigger_check" CHECK ("sync_run"."trigger" in ('schedule', 'manual', 'deploy')),
	CONSTRAINT "sync_run_status_check" CHECK ("sync_run"."status" in ('running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "container_identity" (
	"container" text NOT NULL,
	"recipient" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "container_identity_container_recipient_pk" PRIMARY KEY("container","recipient"),
	CONSTRAINT "container_identity_container" CHECK ("container_identity"."container" in ('api', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"name" text PRIMARY KEY NOT NULL,
	"readers" text[] NOT NULL,
	"hint" text,
	"set_by" text,
	"set_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"check_status" text DEFAULT 'unchecked' NOT NULL,
	"check_message" text,
	CONSTRAINT "secret_readers" CHECK (cardinality("secret"."readers") > 0 and "secret"."readers" <@ array['api', 'worker']),
	CONSTRAINT "secret_check_status" CHECK ("secret"."check_status" in ('passing', 'failing', 'unchecked')),
	CONSTRAINT "secret_check_message" CHECK (char_length("secret"."check_message") <= 300)
);
--> statement-breakpoint
CREATE TABLE "secret_ciphertext" (
	"name" text NOT NULL,
	"reader" text NOT NULL,
	"recipient" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	CONSTRAINT "secret_ciphertext_name_reader_pk" PRIMARY KEY("name","reader"),
	CONSTRAINT "secret_ciphertext_reader" CHECK ("secret_ciphertext"."reader" in ('api', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_key_known" CHECK ("setting"."key" in ('powerbi.tenant_id', 'powerbi.app_client_id', 'powerbi.scanner_client_id', 'powerbi.authority', 'powerbi.api_url', 'powerbi.graph_url', 'powerbi.sync.schedule', 'powerbi.sync.full_scan_schedule', 'powerbi.sync.workspaces.include', 'powerbi.sync.workspaces.exclude', 'powerbi.sync.workspaces.personal', 'powerbi.datasets.new', 'powerbi.service_account_queries', 'powerbi.connection_requires_matching_email', 'powerbi.keep_connections_alive_days', 'access.metadata_visibility', 'access.default_role', 'sign_in.email_password', 'email.from', 'email.base_url', 'sign_in.providers', 'sign_in.passkeys', 'search.provider', 'search.model', 'search.base_url', 'results.ttl_hours', 'results.preview_rows', 'results.page_rows_max', 'results.daily_row_budget', 'queries.rate_per_minute', 'service_accounts.rate_per_minute', 'setup.completed_steps', 'setup.completed_at'))
);
--> statement-breakpoint
CREATE TABLE "book_change" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "book_change_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via" text,
	"element_kind" text NOT NULL,
	"element_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "book_change_principal_kind_check" CHECK ("book_change"."principal_kind" in ('person', 'service_account', 'system')),
	CONSTRAINT "book_change_via_check" CHECK ("book_change"."via" in ('browser', 'mcp', 'api', 'cli'))
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_parent_id_key_key" UNIQUE("parent_id","key")
);
--> statement-breakpoint
CREATE TABLE "conventions" (
	"version" integer PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conventions_document_check" CHECK (jsonb_typeof("conventions"."document") = 'object')
);
--> statement-breakpoint
CREATE TABLE "metric" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"definition" text DEFAULT '' NOT NULL,
	"aliases" text[],
	"when_to_use" text DEFAULT '' NOT NULL,
	"not_the_same_as" text,
	"grain_and_filters" text DEFAULT '' NOT NULL,
	"unit" text,
	"category_id" uuid,
	"owner" text,
	"trust_state" text DEFAULT 'draft' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"origin" text NOT NULL,
	"name_is_generated" boolean DEFAULT false NOT NULL,
	"touched_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_reason" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_name_key" UNIQUE("name"),
	CONSTRAINT "metric_trust_state_check" CHECK ("metric"."trust_state" in ('draft', 'agent_verified', 'human_verified')),
	CONSTRAINT "metric_origin_check" CHECK ("metric"."origin" in ('sync', 'curator')),
	CONSTRAINT "metric_custom_check" CHECK (jsonb_typeof("metric"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "metric_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_id" uuid NOT NULL,
	"measure_id" uuid NOT NULL,
	"period" text DEFAULT 'current' NOT NULL,
	"comparison" text DEFAULT 'none' NOT NULL,
	"comparison_period" text,
	"currency" text,
	"shift_note" text,
	"custom_axes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reads_selection" boolean DEFAULT false NOT NULL,
	"selection_columns" text[] DEFAULT '{}' NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_variant_measure_id_key" UNIQUE("measure_id"),
	CONSTRAINT "metric_variant_comparison_check" CHECK ("metric_variant"."comparison" in ('none', 'difference', 'growth_rate', 'ratio')),
	CONSTRAINT "metric_variant_assigned_by_check" CHECK ("metric_variant"."assigned_by" in ('sync', 'curator')),
	CONSTRAINT "metric_variant_custom_axes_check" CHECK (jsonb_typeof("metric_variant"."custom_axes") = 'object')
);
--> statement-breakpoint
CREATE TABLE "term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"definition" text DEFAULT '' NOT NULL,
	"aliases" text[],
	"not_the_same_as" text,
	"values" jsonb,
	"owner" text,
	"trust_state" text DEFAULT 'draft' NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_name_key" UNIQUE("name"),
	CONSTRAINT "term_trust_state_check" CHECK ("term"."trust_state" in ('draft', 'agent_verified', 'human_verified')),
	CONSTRAINT "term_custom_check" CHECK (jsonb_typeof("term"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "term_column" (
	"term_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	CONSTRAINT "term_column_term_id_column_id_pk" PRIMARY KEY("term_id","column_id")
);
--> statement-breakpoint
CREATE TABLE "term_metric" (
	"term_id" uuid NOT NULL,
	"metric_id" uuid NOT NULL,
	CONSTRAINT "term_metric_term_id_metric_id_pk" PRIMARY KEY("term_id","metric_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"element_kind" text,
	"element_id" text,
	"principal_kind" text,
	"principal_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "event_kind_check" CHECK ("event"."kind" in ('metric.created', 'metric.changed', 'metric.verified', 'metric.approved', 'draft.created', 'variant.moved', 'term.changed', 'conventions.changed', 'thread.created', 'thread.replied', 'thread.answered', 'thread.archived', 'sync.finished', 'sync.failed')),
	CONSTRAINT "event_principal_kind_check" CHECK ("event"."principal_kind" in ('person', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text,
	"resources" text[],
	"oauth_client_id" text
);
--> statement-breakpoint
CREATE TABLE "device_request" (
	"device_code_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_from" text
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}',
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_activity" (
	"client_id" text PRIMARY KEY NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"sign_in_method" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	CONSTRAINT "sso_provider_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_sign_in" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"signed_in_at" timestamp with time zone NOT NULL,
	"group_ids" text[],
	"domain_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "person_sign_in_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "person_sign_in_provider" CHECK ("person_sign_in"."provider" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject" text,
	"provider" text,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignment_once" UNIQUE NULLS NOT DISTINCT("role","subject_kind","provider","subject"),
	CONSTRAINT "role_assignment_subject_kind" CHECK ("role_assignment"."subject_kind" in ('person', 'email_domain', 'group', 'everyone_in_tenant')),
	CONSTRAINT "role_assignment_role" CHECK ("role_assignment"."role" ~ '^[a-z][a-z0-9_]*$' and "role_assignment"."role" <> 'none'),
	CONSTRAINT "role_assignment_privileged_subject" CHECK ("role_assignment"."role" not in ('admin', 'pii_reader') or "role_assignment"."subject_kind" in ('person', 'group')),
	CONSTRAINT "role_assignment_subject" CHECK (("role_assignment"."subject_kind" = 'everyone_in_tenant') = ("role_assignment"."subject" is null)),
	CONSTRAINT "role_assignment_provider" CHECK (("role_assignment"."subject_kind" = 'group') = ("role_assignment"."provider" is not null) and ("role_assignment"."provider" is null or "role_assignment"."provider" ~ '^[a-z][a-z0-9_]*$')),
	CONSTRAINT "role_assignment_subject_lower_case" CHECK ("role_assignment"."subject_kind" not in ('person', 'email_domain') or "role_assignment"."subject" = lower("role_assignment"."subject"))
);
--> statement-breakpoint
CREATE TABLE "powerbi_connect_state" (
	"state_digest" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"next" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "powerbi_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"microsoft_object_id" uuid NOT NULL,
	"user_principal_name" text,
	"group_object_ids" uuid[] DEFAULT '{}' NOT NULL,
	"groups_read_at" timestamp with time zone,
	"groups_attempted_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"access_token_ciphertext" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_ciphertext" "bytea",
	"recipient" text,
	"status" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "powerbi_connection_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "powerbi_connection_status" CHECK ("powerbi_connection"."status" in ('connected', 'needs_reconnect', 'disconnected')),
	CONSTRAINT "powerbi_connection_tokens_while_connected" CHECK (("powerbi_connection"."status" = 'connected') = ("powerbi_connection"."access_token_ciphertext" is not null
        and "powerbi_connection"."access_token_expires_at" is not null
        and "powerbi_connection"."refresh_token_ciphertext" is not null
        and "powerbi_connection"."recipient" is not null))
);
--> statement-breakpoint
CREATE TABLE "service_account" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_email" text NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"app_ids" uuid[] DEFAULT '{}' NOT NULL,
	"source_cidrs" "cidr"[] DEFAULT '{}' NOT NULL,
	"max_key_age_days" integer DEFAULT 90 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_account_name" CHECK ("service_account"."name" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "service_account_roles" CHECK (array_to_json("service_account"."roles")::text ~ '^\[("[a-z][a-z0-9_]*"(,"[a-z][a-z0-9_]*")*)?\]$'
        and not ("service_account"."roles" && array['admin', 'none', 'pii_reader'])),
	CONSTRAINT "service_account_max_key_age_days" CHECK ("service_account"."max_key_age_days" between 1 and 90)
);
--> statement-breakpoint
CREATE TABLE "service_account_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account" text NOT NULL,
	"prefix" text NOT NULL,
	"digest" "bytea" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "service_account_key_digest_unique" UNIQUE("digest"),
	CONSTRAINT "service_account_key_expiry" CHECK ("service_account_key"."expires_at" > "service_account_key"."created_at" and "service_account_key"."expires_at" <= "service_account_key"."created_at" + interval '90 days')
);
--> statement-breakpoint
CREATE TABLE "request_rate" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"via" text NOT NULL,
	"client_id" text,
	"powerbi_account" text,
	"dataset_id" uuid,
	"dataset_name" text,
	"workspace_id" uuid,
	"dax" text NOT NULL,
	"dax_hash" text NOT NULL,
	"purpose" text,
	"status" text NOT NULL,
	"error" text,
	"row_count" integer,
	"column_count" integer,
	"bytes" bigint,
	"duration_ms" integer NOT NULL,
	"result_id" uuid,
	"result_expires_at" timestamp with time zone,
	"measure_names" text[] DEFAULT '{}' NOT NULL,
	"metric_ids" uuid[] DEFAULT '{}' NOT NULL,
	"search_tsv" "tsvector",
	CONSTRAINT "query_log_status_check" CHECK ("query_log"."status" in ('succeeded', 'truncated', 'failed', 'refused')),
	CONSTRAINT "query_log_via_check" CHECK ("query_log"."via" in ('browser', 'mcp', 'api', 'cli')),
	CONSTRAINT "query_log_principal_kind_check" CHECK ("query_log"."principal_kind" in ('person', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "query_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"rows" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "query_reservation_principal_kind_check" CHECK ("query_reservation"."principal_kind" in ('person', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "query_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"columns" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"truncation_note" text,
	"bytes" bigint NOT NULL,
	"page_rows" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "query_result_owner_kind_check" CHECK ("query_result"."owner_kind" in ('person', 'service_account')),
	CONSTRAINT "query_result_truncation_note_check" CHECK ("query_result"."truncated" = ("query_result"."truncation_note" is not null))
);
--> statement-breakpoint
CREATE TABLE "query_result_page" (
	"result_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"rows" jsonb NOT NULL,
	CONSTRAINT "query_result_page_result_id_page_number_pk" PRIMARY KEY("result_id","page_number")
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"element_kind" text NOT NULL,
	"element_id" uuid NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"accepted_reply_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" DEFAULT ''::tsvector NOT NULL,
	CONSTRAINT "thread_kind_check" CHECK ("thread"."kind" in ('question', 'comment')),
	CONSTRAINT "thread_element_kind_check" CHECK ("thread"."element_kind" in ('workspace', 'dataset', 'table', 'column', 'measure', 'metric', 'variant', 'term', 'category', 'query')),
	CONSTRAINT "thread_status_check" CHECK ("thread"."status" in ('open', 'answered', 'archived')),
	CONSTRAINT "thread_author_kind_check" CHECK ("thread"."author_kind" in ('person', 'service_account')),
	CONSTRAINT "thread_title_check" CHECK (("thread"."kind" = 'question' and "thread"."title" is not null and char_length("thread"."title") between 1 and 300) or ("thread"."kind" = 'comment' and "thread"."title" is null)),
	CONSTRAINT "thread_body_check" CHECK (char_length("thread"."body") between 1 and 20000),
	CONSTRAINT "thread_accepted_reply_check" CHECK (("thread"."accepted_reply_id" is null or "thread"."kind" = 'question') and ("thread"."status" <> 'answered' or "thread"."accepted_reply_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "thread_reply" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "thread_reply_thread_id_id_key" UNIQUE("thread_id","id"),
	CONSTRAINT "thread_reply_author_kind_check" CHECK ("thread_reply"."author_kind" in ('person', 'service_account')),
	CONSTRAINT "thread_reply_body_check" CHECK (char_length("thread_reply"."body") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "thread_upvote" (
	"thread_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_upvote_thread_id_principal_kind_principal_id_pk" PRIMARY KEY("thread_id","principal_kind","principal_id"),
	CONSTRAINT "thread_upvote_principal_kind_check" CHECK ("thread_upvote"."principal_kind" in ('person', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "thread_view" (
	"thread_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_view_thread_id_principal_kind_principal_id_pk" PRIMARY KEY("thread_id","principal_kind","principal_id"),
	CONSTRAINT "thread_view_principal_kind_check" CHECK ("thread_view"."principal_kind" in ('person', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "setting_check" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"details" jsonb,
	"action" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "setting_check_status" CHECK ("setting_check"."status" in ('passing', 'failing')),
	CONSTRAINT "setting_check_key" CHECK ("setting_check"."key" ~ '^[a-z][a-z0-9_.]*$'),
	CONSTRAINT "setting_check_message" CHECK (char_length("setting_check"."message") <= 300),
	CONSTRAINT "setting_check_details" CHECK ("setting_check"."details" is null or (jsonb_typeof("setting_check"."details") = 'object' and octet_length("setting_check"."details"::text) <= 262144)),
	CONSTRAINT "setting_check_action" CHECK ("setting_check"."action" in ('sign_in', 'connect'))
);
--> statement-breakpoint
ALTER TABLE "setting_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "setup_link" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"session_digest" text,
	"session_expires_at" timestamp with time zone,
	"sign_in_digest" text,
	"sign_in_expires_at" timestamp with time zone,
	"sign_in_state_digest" text,
	"admitted_user_id" text,
	"signed_in_tenant_id" uuid,
	"signed_in_sample" boolean,
	CONSTRAINT "setup_link_session_digest_unique" UNIQUE("session_digest"),
	CONSTRAINT "setup_link_sign_in_digest_unique" UNIQUE("sign_in_digest")
);
--> statement-breakpoint
CREATE TABLE "embedding_usage" (
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"purpose" text NOT NULL,
	CONSTRAINT "embedding_usage_provider_check" CHECK ("embedding_usage"."provider" in ('openai', 'gemini')),
	CONSTRAINT "embedding_usage_purpose_check" CHECK ("embedding_usage"."purpose" in ('document', 'query')),
	CONSTRAINT "embedding_usage_tokens_check" CHECK ("embedding_usage"."tokens" >= 0),
	CONSTRAINT "embedding_usage_cost_check" CHECK ("embedding_usage"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "search_document" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"element_id" uuid NOT NULL,
	"dataset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"app_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"category_id" uuid,
	"trust_state" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"search_text" text NOT NULL,
	"search_tsv" "tsvector",
	"embedding" vector(1536),
	"embedding_model" text,
	"embedding_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_document_kind_check" CHECK ("search_document"."kind" in ('metric', 'variant', 'column', 'term', 'dataset', 'table', 'category')),
	CONSTRAINT "search_document_custom_check" CHECK (jsonb_typeof("search_document"."custom") = 'object')
);
--> statement-breakpoint
CREATE TABLE "search_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"book_change_id" bigint NOT NULL,
	"book_change_at" timestamp with time zone,
	CONSTRAINT "search_state_one_row_check" CHECK ("search_state"."id")
);
--> statement-breakpoint
CREATE TABLE "pii_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"table_name" text NOT NULL,
	"name" text,
	"pii" boolean NOT NULL,
	"note" text,
	"set_by_kind" text NOT NULL,
	"set_by_id" text NOT NULL,
	"set_via" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pii_rule_kind" CHECK ("pii_rule"."kind" in ('column', 'measure', 'table')),
	CONSTRAINT "pii_rule_name" CHECK (("pii_rule"."kind" = 'table') = ("pii_rule"."name" is null)),
	CONSTRAINT "pii_rule_table_name_length" CHECK (char_length("pii_rule"."table_name") <= 200),
	CONSTRAINT "pii_rule_name_length" CHECK (char_length("pii_rule"."name") <= 200),
	CONSTRAINT "pii_rule_note_length" CHECK (char_length("pii_rule"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "deployment_tenant" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sample" boolean NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_tenant_single_row" CHECK ("deployment_tenant"."id")
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"token_sha256" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_email" CHECK ("invite"."email" = lower("invite"."email") and "invite"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "invite_digest" CHECK ("invite"."token_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "powerbi_app" ADD CONSTRAINT "powerbi_app_workspace_id_powerbi_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."powerbi_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_app_dataset" ADD CONSTRAINT "powerbi_app_dataset_app_id_powerbi_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."powerbi_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_app_dataset" ADD CONSTRAINT "powerbi_app_dataset_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_column" ADD CONSTRAINT "powerbi_column_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_column" ADD CONSTRAINT "powerbi_column_table_id_powerbi_table_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."powerbi_table"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_dataset" ADD CONSTRAINT "powerbi_dataset_workspace_id_powerbi_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."powerbi_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_measure" ADD CONSTRAINT "powerbi_measure_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_measure" ADD CONSTRAINT "powerbi_measure_table_id_powerbi_table_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."powerbi_table"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_relationship" ADD CONSTRAINT "powerbi_relationship_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_table" ADD CONSTRAINT "powerbi_table_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_ciphertext" ADD CONSTRAINT "secret_ciphertext_name_secret_name_fk" FOREIGN KEY ("name") REFERENCES "public"."secret"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric" ADD CONSTRAINT "metric_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_variant" ADD CONSTRAINT "metric_variant_metric_id_metric_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metric"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_variant" ADD CONSTRAINT "metric_variant_measure_id_powerbi_measure_id_fk" FOREIGN KEY ("measure_id") REFERENCES "public"."powerbi_measure"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_column" ADD CONSTRAINT "term_column_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_column" ADD CONSTRAINT "term_column_column_id_powerbi_column_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."powerbi_column"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_metric" ADD CONSTRAINT "term_metric_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_metric" ADD CONSTRAINT "term_metric_metric_id_metric_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metric"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_request" ADD CONSTRAINT "device_request_device_code_id_device_code_id_fk" FOREIGN KEY ("device_code_id") REFERENCES "public"."device_code"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_activity" ADD CONSTRAINT "oauth_client_activity_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_sign_in" ADD CONSTRAINT "person_sign_in_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_connect_state" ADD CONSTRAINT "powerbi_connect_state_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powerbi_connection" ADD CONSTRAINT "powerbi_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_account_key" ADD CONSTRAINT "service_account_key_service_account_service_account_name_fk" FOREIGN KEY ("service_account") REFERENCES "public"."service_account"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_result_page" ADD CONSTRAINT "query_result_page_result_id_query_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."query_result"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_accepted_reply_fkey" FOREIGN KEY ("id","accepted_reply_id") REFERENCES "public"."thread_reply"("thread_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reply" ADD CONSTRAINT "thread_reply_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_upvote" ADD CONSTRAINT "thread_upvote_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_view" ADD CONSTRAINT "thread_view_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_link" ADD CONSTRAINT "setup_link_admitted_user_id_user_id_fk" FOREIGN KEY ("admitted_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_at" ON "audit_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "job_request_queued" ON "job_request" USING btree ("runner","requested_at") WHERE "job_request"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "powerbi_access_principal_idx" ON "powerbi_access" USING btree ("principal_type","principal_object_id");--> statement-breakpoint
CREATE INDEX "powerbi_app_workspace_id_idx" ON "powerbi_app" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "powerbi_app_dataset_dataset_id_idx" ON "powerbi_app_dataset" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "powerbi_column_dataset_id_removed_at_idx" ON "powerbi_column" USING btree ("dataset_id","removed_at");--> statement-breakpoint
CREATE INDEX "powerbi_dataset_workspace_id_idx" ON "powerbi_dataset" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "powerbi_measure_dataset_id_removed_at_idx" ON "powerbi_measure" USING btree ("dataset_id","removed_at");--> statement-breakpoint
CREATE INDEX "powerbi_measure_table_id_idx" ON "powerbi_measure" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "powerbi_relationship_dataset_id_removed_at_idx" ON "powerbi_relationship" USING btree ("dataset_id","removed_at");--> statement-breakpoint
CREATE INDEX "powerbi_table_dataset_id_removed_at_idx" ON "powerbi_table" USING btree ("dataset_id","removed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "container_identity_current" ON "container_identity" USING btree ("container") WHERE "container_identity"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "category_root_key_idx" ON "category" USING btree ("key") WHERE "category"."parent_id" is null;--> statement-breakpoint
CREATE INDEX "metric_trust_state_idx" ON "metric" USING btree ("trust_state");--> statement-breakpoint
CREATE INDEX "metric_category_id_idx" ON "metric" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "metric_variant_metric_id_idx" ON "metric_variant" USING btree ("metric_id");--> statement-breakpoint
CREATE INDEX "term_column_column_id_idx" ON "term_column" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "term_metric_metric_id_idx" ON "term_metric" USING btree ("metric_id");--> statement-breakpoint
CREATE INDEX "event_kind_id_idx" ON "event" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauth_access_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauth_access_token" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX "oauthClient_userId_idx" ON "oauth_client" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_clientId_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthConsent_userId_idx" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauth_refresh_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauth_refresh_token" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "powerbi_connect_state_expires_at" ON "powerbi_connect_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "powerbi_connect_state_session_id" ON "powerbi_connect_state" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "powerbi_connection_microsoft_object_id_idx" ON "powerbi_connection" USING btree ("microsoft_object_id");--> statement-breakpoint
CREATE INDEX "service_account_key_service_account" ON "service_account_key" USING btree ("service_account");--> statement-breakpoint
CREATE INDEX "query_log_at_idx" ON "query_log" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "query_log_principal_idx" ON "query_log" USING btree ("principal_kind","principal_id","at");--> statement-breakpoint
CREATE INDEX "query_log_result_id_idx" ON "query_log" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "query_log_search_tsv_idx" ON "query_log" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "query_log_metric_ids_idx" ON "query_log" USING gin ("metric_ids");--> statement-breakpoint
CREATE INDEX "query_reservation_principal_idx" ON "query_reservation" USING btree ("principal_kind","principal_id");--> statement-breakpoint
CREATE INDEX "query_result_expires_at_idx" ON "query_result" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "thread_element_idx" ON "thread" USING btree ("element_kind","element_id");--> statement-breakpoint
CREATE INDEX "thread_author_idx" ON "thread" USING btree ("author_kind","author_id");--> statement-breakpoint
CREATE INDEX "thread_created_at_idx" ON "thread" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "thread_search_tsv_idx" ON "thread" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "thread_reply_thread_id_created_at_idx" ON "thread_reply" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "embedding_usage_at_idx" ON "embedding_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "search_document_element_id_idx" ON "search_document" USING btree ("element_id");--> statement-breakpoint
CREATE INDEX "search_document_search_tsv_idx" ON "search_document" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "pii_rule_name_idx" ON "pii_rule" USING btree ("kind",replace(replace(replace(replace(lower(normalize("table_name", NFKC)), 'ß', 'ss'), 'ſ', 's'), 'ı', 'i'), 'ς', 'σ'),replace(replace(replace(replace(lower(normalize(coalesce("name", ''), NFKC)), 'ß', 'ss'), 'ſ', 's'), 'ı', 'i'), 'ς', 'σ'));--> statement-breakpoint
CREATE UNIQUE INDEX "invite_open_email" ON "invite" USING btree ("email") WHERE "invite"."used_at" is null;--> statement-breakpoint
CREATE POLICY "setting_check_api" ON "setting_check" AS PERMISSIVE FOR ALL TO "api_rw" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "setting_check_worker" ON "setting_check" AS PERMISSIVE FOR ALL TO "worker_rw" USING ("setting_check"."key" in ('scanner', 'what_to_sync')) WITH CHECK ("setting_check"."key" in ('scanner', 'what_to_sync'));