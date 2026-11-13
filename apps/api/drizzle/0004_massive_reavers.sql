DROP INDEX "invite_open_email";--> statement-breakpoint
CREATE UNIQUE INDEX "invite_open_email" ON "invite" USING btree ("email") WHERE "invite"."accepted_at" is null and "invite"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "invite" DROP COLUMN "used_at";