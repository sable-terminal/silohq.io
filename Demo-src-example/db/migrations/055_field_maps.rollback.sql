ALTER TABLE concept_objects DROP CONSTRAINT IF EXISTS concept_objects_field_map_flat;
ALTER TABLE concept_objects DROP COLUMN IF EXISTS field_map;
