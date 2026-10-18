-- Attach optimistic-concurrency version trigger to source_documents
CREATE TRIGGER source_documents_bump_version
  BEFORE UPDATE ON "source_documents"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();
