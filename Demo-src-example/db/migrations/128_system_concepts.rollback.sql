DELETE FROM concept_objects WHERE concept_id IN (SELECT id FROM concepts WHERE origin = 'system');
DELETE FROM concepts WHERE origin = 'system';
ALTER TABLE concepts DROP CONSTRAINT concepts_origin_check;
ALTER TABLE concepts ADD CONSTRAINT concepts_origin_check CHECK (origin IN ('confirmed', 'corrected', 'manual'));
