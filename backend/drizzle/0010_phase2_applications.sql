CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'under_review', 'documents_required', 'hearing_scheduled', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."application_type" AS ENUM('mutation', 'record_correction', 'certified_copy');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"origin" "data_origin" NOT NULL,
	"type" "application_type" NOT NULL,
	"status" "application_status" DEFAULT 'draft' NOT NULL,
	"tracking_number" text,
	"district" text NOT NULL,
	"upazila" text NOT NULL,
	"mouza" text NOT NULL,
	"khatian_number" text NOT NULL,
	"dag_number" text NOT NULL,
	"area_decimal" numeric(14, 4),
	"share_numerator" integer,
	"share_denominator" integer,
	"parcel_id" uuid,
	"declared_documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"next_step" text,
	"deadline" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_version_positive" CHECK ("applications"."version" >= 1),
	CONSTRAINT "applications_area_non_negative" CHECK ("applications"."area_decimal" is null or "applications"."area_decimal" >= 0),
	CONSTRAINT "applications_share_complete" CHECK (("applications"."share_numerator" is null) = ("applications"."share_denominator" is null)),
	CONSTRAINT "applications_share_non_negative" CHECK ("applications"."share_numerator" is null or "applications"."share_numerator" >= 0),
	CONSTRAINT "applications_share_denominator_positive" CHECK ("applications"."share_denominator" is null or "applications"."share_denominator" > 0),
	CONSTRAINT "applications_tracking_number_matches_status" CHECK (("applications"."status" = 'draft' and "applications"."tracking_number" is null)
          or ("applications"."status" <> 'draft' and "applications"."tracking_number" is not null)),
	CONSTRAINT "applications_submitted_at_matches_status" CHECK ("applications"."status" = 'draft' or "applications"."submitted_at" is not null),
	CONSTRAINT "applications_decided_at_matches_status" CHECK ("applications"."decided_at" is null
          or "applications"."status" in ('approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_parcel_id_parcels_id_fk" FOREIGN KEY ("parcel_id") REFERENCES "public"."parcels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_tracking_number_unique" ON "applications" USING btree ("tracking_number") WHERE "applications"."tracking_number" is not null;--> statement-breakpoint
CREATE INDEX "applications_owner_idx" ON "applications" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "applications_parcel_idx" ON "applications" USING btree ("parcel_id");--> statement-breakpoint

-- `updated_at` and `version` are maintained by the database, reusing the
-- functions added in migrations 0001 and 0004, so every write path — including a
-- future script or a manual statement — keeps them consistent. Without the
-- version trigger the optimistic-concurrency token would only advance when
-- application code remembered to advance it.
CREATE TRIGGER applications_touch_updated_at
  BEFORE UPDATE ON "applications"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER applications_bump_version
  BEFORE UPDATE ON "applications"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();
