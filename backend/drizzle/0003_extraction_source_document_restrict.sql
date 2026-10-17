ALTER TABLE "extractions" DROP CONSTRAINT "extractions_source_document_id_source_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extractions_source_document_idx" ON "extractions" USING btree ("source_document_id");