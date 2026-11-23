-- Fix legal hold release trigger enum casts and atomic count/status update.
CREATE OR REPLACE FUNCTION laundry_legal_hold_sync() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE evidence_assets
       SET legal_hold_count = legal_hold_count + 1,
           status = 'legal_hold'::evidence_state
     WHERE id = NEW.asset_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    UPDATE evidence_assets
       SET legal_hold_count = GREATEST(legal_hold_count - 1, 0),
           status = CASE
             WHEN GREATEST(legal_hold_count - 1, 0) = 0 THEN 'retained'::evidence_state
             ELSE 'legal_hold'::evidence_state
           END
     WHERE id = NEW.asset_id;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
