/* A learned match was never written into a concept, so dropping them loses nothing a concept holds. */
DELETE FROM field_aliases WHERE origin = 'learned';

ALTER TABLE field_aliases
  DROP CONSTRAINT IF EXISTS field_aliases_evidence,
  DROP COLUMN IF EXISTS agreed,
  DROP COLUMN IF EXISTS compared,
  DROP COLUMN IF EXISTS origin;
