DROP INDEX IF EXISTS automations_watching_findings;
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_source_matches_view;
ALTER TABLE automations DROP COLUMN IF EXISTS source;
DELETE FROM automations WHERE saved_view_id IS NULL;
ALTER TABLE automations ALTER COLUMN saved_view_id SET NOT NULL;
