CREATE TYPE "public"."checklist_outcome" AS ENUM('pass', 'fail', 'needs_review', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."data_origin" AS ENUM('synthetic_demo', 'user_created');--> statement-breakpoint
CREATE TYPE "public"."processing_job_kind" AS ENUM('document_extraction', 'parcel_reconciliation', 'readiness_report');--> statement-breakpoint
CREATE TYPE "public"."processing_job_status" AS ENUM('queued', 'processing', 'review_required', 'completed', 'failed', 'retry_pending', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."readiness_outcome" AS ENUM('ready_for_review', 'needs_review', 'not_ready');--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"label" text,
	"width" integer,
	"height" integer,
	"region" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_pages_page_number_positive" CHECK ("document_pages"."page_number" >= 1),
	CONSTRAINT "document_pages_dimensions_positive" CHECK (("document_pages"."width" is null or "document_pages"."width" > 0) and ("document_pages"."height" is null or "document_pages"."height" > 0))
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "processing_job_kind" NOT NULL,
	"status" "processing_job_status" DEFAULT 'queued' NOT NULL,
	"parcel_id" uuid,
	"source_document_id" uuid,
	"requested_by" uuid,
	"idempotency_key" text,
	"payload" jsonb,
	"result" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_attempts_non_negative" CHECK ("processing_jobs"."attempt_count" >= 0),
	CONSTRAINT "processing_jobs_max_attempts_positive" CHECK ("processing_jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "readiness_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"outcome" "checklist_outcome" NOT NULL,
	"severity" "finding_severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"observed_value" text,
	"expected_value" text,
	"evidence_reference" text,
	"record_references" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readiness_checklist_items_sort_order_non_negative" CHECK ("readiness_checklist_items"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "readiness_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid NOT NULL,
	"requested_by" uuid,
	"outcome" "readiness_outcome" NOT NULL,
	"rules_version" text NOT NULL,
	"summary" text NOT NULL,
	"counts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
-- `origin` classifies who a record belongs to, so it is NOT NULL with no
-- default: every writer must state whether it is storing demo data or a real
-- account's record. Existing rows all predate Phase 2 and came from the
-- synthetic seed or test fixtures, so they are backfilled as demo data before
-- the constraint is applied.
ALTER TABLE "parcels" ADD COLUMN "origin" "data_origin";--> statement-breakpoint
UPDATE "parcels" SET "origin" = 'synthetic_demo' WHERE "origin" IS NULL;--> statement-breakpoint
ALTER TABLE "parcels" ALTER COLUMN "origin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "origin" "data_origin";--> statement-breakpoint
UPDATE "source_documents" SET "origin" = 'synthetic_demo' WHERE "origin" IS NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ALTER COLUMN "origin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "page_id" uuid;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "bounding_box" jsonb;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "provider_model" text;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "rule_code" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_checklist_items" ADD CONSTRAINT "readiness_checklist_items_report_id_readiness_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."readiness_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_reports" ADD CONSTRAINT "readiness_reports_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_reports" ADD CONSTRAINT "readiness_reports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_pages_document_page_unique" ON "document_pages" USING btree ("source_document_id","page_number");--> statement-breakpoint
CREATE INDEX "document_pages_document_idx" ON "document_pages" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_claim_idx" ON "processing_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_idempotency_key_unique" ON "processing_jobs" USING btree ("idempotency_key") WHERE "processing_jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "processing_jobs_parcel_idx" ON "processing_jobs" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_document_idx" ON "processing_jobs" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_requested_by_idx" ON "processing_jobs" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "readiness_checklist_items_report_idx" ON "readiness_checklist_items" USING btree ("report_id","sort_order");--> statement-breakpoint
CREATE INDEX "readiness_reports_parcel_idx" ON "readiness_reports" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "readiness_reports_created_at_idx" ON "readiness_reports" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_page_id_document_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."document_pages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parcels_owner_idx" ON "parcels" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "source_documents_owner_idx" ON "source_documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "extractions_page_idx" ON "extractions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "findings_rule_code_idx" ON "findings" USING btree ("rule_code");--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_version_positive" CHECK ("parcels"."version" >= 1);--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_byte_size_non_negative" CHECK ("source_documents"."byte_size" is null or "source_documents"."byte_size" >= 0);--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_version_positive" CHECK ("extractions"."version" >= 1);--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_version_positive" CHECK ("findings"."version" >= 1);--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Phase 2 integrity guards
-- --------------------------------------------------------------------------

-- `updated_at` maintenance for the new mutable table. The Phase 1 function is
-- reused as-is; only a new trigger is added.
CREATE TRIGGER processing_jobs_touch_updated_at
  BEFORE UPDATE ON "processing_jobs"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

-- Optimistic-concurrency token maintenance.
--
-- The version is bumped by the database rather than by application code, so
-- every code path — including a future script or a manual statement — advances
-- the token. A writer that states an explicit version keeps it, so an operator
-- can still perform a deliberate override if one is ever needed.
CREATE OR REPLACE FUNCTION bhoomitrace_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER parcels_bump_version
  BEFORE UPDATE ON "parcels"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();--> statement-breakpoint

CREATE TRIGGER extractions_bump_version
  BEFORE UPDATE ON "extractions"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();--> statement-breakpoint

CREATE TRIGGER findings_bump_version
  BEFORE UPDATE ON "findings"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();
