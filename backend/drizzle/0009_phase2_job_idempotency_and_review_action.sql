CREATE TYPE "public"."finding_review_action" AS ENUM('under_review', 'resolved', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."review_outcome" ADD VALUE 'dismissed';--> statement-breakpoint
DROP INDEX "processing_jobs_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "review_decisions" ADD COLUMN "finding_action" "finding_review_action";--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_idempotency_key_user_unique" ON "processing_jobs" USING btree ("requested_by","idempotency_key") WHERE "processing_jobs"."requested_by" is not null and "processing_jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_idempotency_key_system_unique" ON "processing_jobs" USING btree ("idempotency_key") WHERE "processing_jobs"."requested_by" is null and "processing_jobs"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_finding_action_scope" CHECK ("review_decisions"."finding_action" is null or "review_decisions"."finding_id" is not null);