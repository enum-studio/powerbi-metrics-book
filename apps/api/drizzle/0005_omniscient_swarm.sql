CREATE TABLE "oauth_consent_use" (
	"consent_id" text PRIMARY KEY NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_consent_use" ADD CONSTRAINT "oauth_consent_use_consent_id_oauth_consent_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."oauth_consent"("id") ON DELETE cascade ON UPDATE no action;