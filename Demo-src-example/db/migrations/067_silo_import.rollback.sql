DELETE FROM role_permissions WHERE permission_id = 'silo.import';
DELETE FROM permissions WHERE id = 'silo.import';

ALTER TABLE purge_receipts DROP CONSTRAINT purge_receipts_scope_shape;
ALTER TABLE purge_receipts ADD CONSTRAINT purge_receipts_scope_shape CHECK (
     (scope = 'silo'    AND concept_id IS NULL     AND entity_ref IS NULL)
  OR (scope = 'concept' AND concept_id IS NOT NULL AND entity_ref IS NULL)
  OR (scope = 'entity'  AND concept_id IS NOT NULL AND entity_ref IS NOT NULL)
) NOT VALID;
ALTER TABLE purge_receipts
  DROP COLUMN rows_removed,
  DROP COLUMN files_removed,
  DROP COLUMN object_name,
  DROP COLUMN source_id,
  DROP COLUMN file_id;
ALTER TABLE purge_receipts DROP CONSTRAINT purge_receipts_scope_check;
ALTER TABLE purge_receipts ADD CONSTRAINT purge_receipts_scope_check
  CHECK (scope IN ('entity', 'concept', 'silo'));

ALTER TABLE siloes DROP COLUMN extraction_operations;

DROP TABLE silo_rows;
ALTER TABLE silo_definitions DROP CONSTRAINT silo_definitions_probed_file;
DROP TABLE silo_files;
DROP TABLE silo_sources;
DROP TRIGGER silo_definitions_immutable_once_published ON silo_definitions;
DROP FUNCTION silo_definitions_refuse_edit_once_published();
DROP TABLE silo_definitions;

DELETE FROM connector_transports WHERE kind = 'silo_import';
