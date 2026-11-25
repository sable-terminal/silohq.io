DELETE FROM role_permissions
 WHERE permission_id IN ('silo.create', 'silo.manage')
   AND role_id IN (SELECT id FROM roles WHERE system_role AND name = 'Admin');

ALTER TABLE siloes DROP COLUMN bytes_scanned;

DROP INDEX silo_concepts_one_silo_per_concept;
CREATE UNIQUE INDEX silo_concepts_one_live
  ON silo_concepts (silo_id, concept_id) WHERE removed_at IS NULL;

ALTER TABLE purge_receipts DROP CONSTRAINT purge_receipts_scope_shape;
ALTER TABLE purge_receipts ADD COLUMN target text;
UPDATE purge_receipts SET target = COALESCE(entity_ref, concept_id::text);
ALTER TABLE purge_receipts
  DROP COLUMN concept_id,
  DROP COLUMN entity_ref,
  DROP COLUMN silo_disabled;

/* Fold every dated partition back into the default: detach, re-insert through
   the parent (which now routes to the default), drop. */
DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'transitions'::regclass
       AND c.relname ~ '^transitions_y[0-9]{4}m[0-9]{2}$'
  LOOP
    EXECUTE format('ALTER TABLE transitions DETACH PARTITION %I', part.relname);
    EXECUTE format('INSERT INTO transitions SELECT * FROM %I', part.relname);
    EXECUTE format('DROP TABLE %I', part.relname);
  END LOOP;
END;
$$;

DROP FUNCTION silo_drop_empty_transition_partitions();
DROP FUNCTION silo_ensure_transition_partitions(integer);

DROP INDEX transitions_by_silo_and_age;
ALTER TABLE transitions DROP CONSTRAINT transitions_values_bounded;

ALTER TABLE silo_baselines DROP CONSTRAINT silo_baselines_value_bounded;
DROP INDEX silo_baselines_by_age;
DELETE FROM silo_baselines;
ALTER TABLE silo_baselines DROP CONSTRAINT silo_baselines_unique;
ALTER TABLE silo_baselines DROP COLUMN connection_id;
ALTER TABLE silo_baselines ADD CONSTRAINT silo_baselines_unique
  UNIQUE (silo_id, concept_id, entity_ref, field_path);
