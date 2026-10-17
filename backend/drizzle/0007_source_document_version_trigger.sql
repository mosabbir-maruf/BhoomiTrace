-- Optimistic-concurrency token for source documents.
--
-- `source_documents.version` arrived with migration 0006, but the trigger that
-- advances it did not: the column existed and the `>= 1` check held, yet nothing
-- ever incremented it. Every update would have left the token at its initial
-- value, so two people editing the same document metadata would both have been
-- told they were writing against the same revision. This adds the missing
-- trigger.
--
-- It reuses `bhoomitrace_bump_version()` from migration 0004 rather than
-- defining a second implementation, so all four versioned tables — parcels,
-- source documents, extractions, and findings — advance their token by exactly
-- the same rule: a writer that states an explicit new version keeps it, and any
-- other update advances the token by one.
CREATE TRIGGER source_documents_bump_version
  BEFORE UPDATE ON "source_documents"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_bump_version();
