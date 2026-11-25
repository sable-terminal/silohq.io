/*
 * A learned concept is retired rather than deleted — findings and saved
 * questions may point at it — and then reads as one a person confirmed, which
 * is the nearest thing the older constraint allows.
 */
UPDATE concepts SET retired_at = COALESCE(retired_at, now()), origin = 'confirmed' WHERE origin = 'learned';
UPDATE concept_proposals SET decision = 'confirmed' WHERE decision = 'learned';

ALTER TABLE concept_proposals DROP CONSTRAINT concept_proposals_concept_needs_yes;
ALTER TABLE concept_proposals ADD CONSTRAINT concept_proposals_concept_needs_yes
  CHECK (concept_id IS NULL OR decision IN ('confirmed', 'corrected'));

ALTER TABLE concept_proposals DROP CONSTRAINT concept_proposals_decision_check;
ALTER TABLE concept_proposals ADD CONSTRAINT concept_proposals_decision_check
  CHECK (decision IS NULL OR decision IN ('confirmed', 'corrected', 'rejected'));

ALTER TABLE concepts DROP CONSTRAINT concepts_origin_check;
ALTER TABLE concepts ADD CONSTRAINT concepts_origin_check
  CHECK (origin IN ('confirmed', 'corrected', 'manual', 'system'));
