-- The scrub is not reversible: the values are gone, which is the point.
ALTER TABLE heal_proposals DROP CONSTRAINT IF EXISTS heal_proposals_no_samples;
