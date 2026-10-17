CREATE TYPE "public"."document_status" AS ENUM('requested', 'in_review', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."extraction_field" AS ENUM('khatian', 'mouza', 'dag', 'area', 'share', 'owner');--> statement-breakpoint
CREATE TYPE "public"."extraction_review_status" AS ENUM('pending', 'confirmed', 'corrected', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."finding_kind" AS ENUM('area_mismatch', 'share_mismatch', 'dag_mismatch', 'khatian_mismatch', 'mouza_mismatch', 'lineage_break', 'unclear_reading', 'other');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('info', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'under_review', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."lineage_certainty" AS ENUM('confirmed', 'illustrative', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."lineage_relation" AS ENUM('continued', 'renumbered', 'split', 'merge');--> statement-breakpoint
CREATE TYPE "public"."review_outcome" AS ENUM('verified', 'correction', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."source_document_kind" AS ENUM('synthetic_demo', 'manual_entry', 'external_reference');--> statement-breakpoint
CREATE TYPE "public"."survey_version" AS ENUM('CS', 'SA', 'RS', 'BS');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('applicant', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'applicant' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parcel_dags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid NOT NULL,
	"dag_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survey" "survey_version" NOT NULL,
	"khatian_number" text NOT NULL,
	"mouza" text NOT NULL,
	"jl_number" text NOT NULL,
	"upazila" text NOT NULL,
	"district" text NOT NULL,
	"area_decimal" numeric(14, 4) NOT NULL,
	"share_numerator" integer DEFAULT 1 NOT NULL,
	"share_denominator" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parcels_area_non_negative" CHECK ("parcels"."area_decimal" >= 0),
	CONSTRAINT "parcels_share_numerator_non_negative" CHECK ("parcels"."share_numerator" >= 0),
	CONSTRAINT "parcels_share_denominator_positive" CHECK ("parcels"."share_denominator" > 0)
);
--> statement-breakpoint
CREATE TABLE "parcel_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_parcel_id" uuid NOT NULL,
	"to_parcel_id" uuid NOT NULL,
	"relation" "lineage_relation" NOT NULL,
	"certainty" "lineage_certainty" DEFAULT 'unverified' NOT NULL,
	"evidence_reference" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parcel_lineage_not_self_referential" CHECK ("parcel_lineage"."from_parcel_id" <> "parcel_lineage"."to_parcel_id")
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"kind" "source_document_kind" DEFAULT 'synthetic_demo' NOT NULL,
	"reference" text,
	"page_count" integer,
	"checksum_sha256" text,
	"status" "document_status" DEFAULT 'submitted' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_page_count_non_negative" CHECK ("source_documents"."page_count" is null or "source_documents"."page_count" >= 0),
	CONSTRAINT "source_documents_checksum_shape" CHECK ("source_documents"."checksum_sha256" is null or "source_documents"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid NOT NULL,
	"source_document_id" uuid,
	"field" "extraction_field" NOT NULL,
	"recorded_value" text NOT NULL,
	"reviewed_value" text,
	"review_status" "extraction_review_status" DEFAULT 'pending' NOT NULL,
	"confidence" numeric(4, 3),
	"is_unclear" boolean DEFAULT false NOT NULL,
	"page_reference" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_confidence_range" CHECK ("extractions"."confidence" is null or ("extractions"."confidence" >= 0 and "extractions"."confidence" <= 1)),
	CONSTRAINT "extractions_reviewed_value_consistency" CHECK (("extractions"."review_status" = 'corrected') = ("extractions"."reviewed_value" is not null))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parcel_id" uuid NOT NULL,
	"related_parcel_id" uuid,
	"extraction_id" uuid,
	"kind" "finding_kind" NOT NULL,
	"severity" "finding_severity" DEFAULT 'info' NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid,
	"extraction_id" uuid,
	"reviewer_id" uuid NOT NULL,
	"outcome" "review_outcome" NOT NULL,
	"extracted_value" text,
	"proposed_value" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decisions_target_present" CHECK ("review_decisions"."finding_id" is not null or "review_decisions"."extraction_id" is not null),
	CONSTRAINT "review_decisions_proposed_value_matches_outcome" CHECK (("review_decisions"."outcome" = 'correction') or "review_decisions"."proposed_value" is null)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text,
	"changes" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parcel_dags" ADD CONSTRAINT "parcel_dags_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_lineage" ADD CONSTRAINT "parcel_lineage_from_parcel_id_parcels_id_fk" FOREIGN KEY ("from_parcel_id") REFERENCES "public"."parcels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_lineage" ADD CONSTRAINT "parcel_lineage_to_parcel_id_parcels_id_fk" FOREIGN KEY ("to_parcel_id") REFERENCES "public"."parcels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcel_lineage" ADD CONSTRAINT "parcel_lineage_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_related_parcel_id_parcels_id_fk" FOREIGN KEY ("related_parcel_id") REFERENCES "public"."parcels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "parcel_dags_parcel_dag_unique" ON "parcel_dags" USING btree ("parcel_id","dag_number");--> statement-breakpoint
CREATE UNIQUE INDEX "parcels_identity_unique" ON "parcels" USING btree ("survey","district","upazila","mouza","jl_number","khatian_number");--> statement-breakpoint
CREATE INDEX "parcels_location_idx" ON "parcels" USING btree ("district","upazila","mouza");--> statement-breakpoint
CREATE UNIQUE INDEX "parcel_lineage_edge_unique" ON "parcel_lineage" USING btree ("from_parcel_id","to_parcel_id","relation");--> statement-breakpoint
CREATE INDEX "parcel_lineage_to_idx" ON "parcel_lineage" USING btree ("to_parcel_id");--> statement-breakpoint
CREATE INDEX "source_documents_status_idx" ON "source_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "extractions_parcel_idx" ON "extractions" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "extractions_review_status_idx" ON "extractions" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "findings_parcel_idx" ON "findings" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "findings_status_severity_idx" ON "findings" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "review_decisions_finding_idx" ON "review_decisions" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "review_decisions_extraction_idx" ON "review_decisions" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX "review_decisions_reviewer_idx" ON "review_decisions" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");