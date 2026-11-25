ALTER TABLE silo_extractions DROP CONSTRAINT IF EXISTS silo_extractions_located;

/* A value located only in text cannot survive a schema that requires a page. */
DELETE FROM silo_extractions WHERE page IS NULL;

ALTER TABLE silo_extractions DROP COLUMN IF EXISTS text_length;
ALTER TABLE silo_extractions DROP COLUMN IF EXISTS text_offset;
ALTER TABLE silo_extractions ALTER COLUMN box_height SET NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_width SET NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_y SET NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN box_x SET NOT NULL;
ALTER TABLE silo_extractions ALTER COLUMN page SET NOT NULL;

DROP TABLE IF EXISTS extraction_carveouts;
