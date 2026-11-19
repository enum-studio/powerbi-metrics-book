ALTER TABLE "powerbi_column" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "powerbi_column" ADD COLUMN "blank_means" text;--> statement-breakpoint
ALTER TABLE "powerbi_dataset" ADD COLUMN "when_to_use" text;--> statement-breakpoint
ALTER TABLE "powerbi_dataset" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "powerbi_dataset" ADD COLUMN "freshness" text;--> statement-breakpoint
ALTER TABLE "powerbi_dataset" ADD COLUMN "caveats" text;--> statement-breakpoint
ALTER TABLE "powerbi_table" ADD COLUMN "grain_and_filters" text;--> statement-breakpoint
ALTER TABLE "powerbi_table" ADD COLUMN "caveats" text;