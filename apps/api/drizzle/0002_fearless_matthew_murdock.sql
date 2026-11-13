CREATE TABLE "model_view_read" (
	"user_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_view_read_user_id_dataset_id_pk" PRIMARY KEY("user_id","dataset_id")
);
--> statement-breakpoint
ALTER TABLE "model_view_read" ADD CONSTRAINT "model_view_read_dataset_id_powerbi_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."powerbi_dataset"("id") ON DELETE cascade ON UPDATE no action;