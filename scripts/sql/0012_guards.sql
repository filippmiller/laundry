--> statement-breakpoint
-- Append-only guards for custody, accounting and security audit records.
CREATE OR REPLACE FUNCTION laundry_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % is immutable; use a compensating event', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER custody_events_append_only BEFORE UPDATE OR DELETE ON custody_events
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION laundry_append_only_guard();
--> statement-breakpoint
-- A container and a seal may belong to at most one active assignment.
CREATE UNIQUE INDEX container_assignments_active_container_unique
  ON container_assignments (container_id) WHERE unassigned_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX container_assignments_active_seal_unique
  ON container_assignments (seal_id) WHERE unassigned_at IS NULL AND seal_id IS NOT NULL;
--> statement-breakpoint
-- Legal hold counter stays in sync with the hold records.
CREATE OR REPLACE FUNCTION laundry_legal_hold_sync() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE evidence_assets SET legal_hold_count = legal_hold_count + 1 WHERE id = NEW.asset_id;
    UPDATE evidence_assets SET status = 'legal_hold' WHERE id = NEW.asset_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    UPDATE evidence_assets SET legal_hold_count = GREATEST(legal_hold_count - 1, 0) WHERE id = NEW.asset_id;
    UPDATE evidence_assets SET status = CASE WHEN legal_hold_count = 0 THEN 'retained' ELSE 'legal_hold' END
      WHERE id = NEW.asset_id;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER evidence_legal_holds_sync AFTER INSERT OR UPDATE ON evidence_legal_holds
  FOR EACH ROW EXECUTE FUNCTION laundry_legal_hold_sync();
--> statement-breakpoint
-- Balanced journals are checked at commit so multi-row postings can be built incrementally.
CREATE OR REPLACE FUNCTION laundry_assert_balanced_journal() RETURNS trigger AS $$
DECLARE
  bad uuid;
BEGIN
  SELECT journal_id INTO bad FROM (
    SELECT journal_id, SUM(debit_kopeks) AS d, SUM(credit_kopeks) AS c
    FROM ledger_entries GROUP BY journal_id
  ) totals WHERE d <> c LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: %', bad USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journal_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION laundry_assert_balanced_journal();
