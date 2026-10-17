-- Integrity guards applied on top of the generated schema.
--
-- 1. `updated_at` is maintained by the database so that it can never drift from
--    the row it describes, regardless of which code path performs the write.
-- 2. `review_decisions` and `audit_events` are append-only. A reviewer decision
--    or audit record is never overwritten or removed: a correction adds a new
--    row instead. This is enforced here, not merely by convention.

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bhoomitrace_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER parcels_touch_updated_at
  BEFORE UPDATE ON "parcels"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER source_documents_touch_updated_at
  BEFORE UPDATE ON "source_documents"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER extractions_touch_updated_at
  BEFORE UPDATE ON "extractions"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER findings_touch_updated_at
  BEFORE UPDATE ON "findings"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_touch_updated_at();--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Append-only enforcement
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bhoomitrace_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'append-only table %.% rejects %',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;--> statement-breakpoint

CREATE TRIGGER review_decisions_append_only
  BEFORE UPDATE OR DELETE ON "review_decisions"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_reject_mutation();--> statement-breakpoint

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION bhoomitrace_reject_mutation();
