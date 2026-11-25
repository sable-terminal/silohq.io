DROP INDEX IF EXISTS findings_by_score;
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_score_components_bounded;
ALTER TABLE findings
  DROP COLUMN IF EXISTS score_components,
  DROP COLUMN IF EXISTS score,
  DROP COLUMN IF EXISTS raised_count,
  DROP COLUMN IF EXISTS first_detected_at;
