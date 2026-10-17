CREATE TYPE "public"."parcel_lifecycle" AS ENUM('active', 'retired');--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "lifecycle" "parcel_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "retirement_reason" text;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "retired_by" uuid;--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parcels_lifecycle_idx" ON "parcels" USING btree ("lifecycle");