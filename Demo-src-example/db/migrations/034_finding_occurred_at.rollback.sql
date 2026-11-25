DROP INDEX IF EXISTS findings_occurred;
ALTER TABLE findings DROP COLUMN IF EXISTS occurred_at;
