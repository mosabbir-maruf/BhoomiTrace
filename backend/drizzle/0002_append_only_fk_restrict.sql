ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_finding_id_findings_id_fk";
--> statement-breakpoint
ALTER TABLE "review_decisions" DROP CONSTRAINT "review_decisions_extraction_id_extractions_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;