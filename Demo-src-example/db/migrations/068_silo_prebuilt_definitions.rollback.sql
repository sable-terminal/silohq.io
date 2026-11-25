CREATE OR REPLACE FUNCTION silo_definitions_refuse_edit_once_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'Definition % is published and cannot be deleted.', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' AND (
       NEW.document       IS DISTINCT FROM OLD.document
    OR NEW.version        IS DISTINCT FROM OLD.version
    OR NEW.definition_key IS DISTINCT FROM OLD.definition_key
    OR NEW.status         IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'Definition % is published and cannot be edited. Draft a new version.', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE silo_definitions DISABLE TRIGGER silo_definitions_immutable_once_published;
DELETE FROM silo_definitions WHERE organisation_id IS NULL AND definition_key IN ('prebuilt-transactions', 'prebuilt-contacts');
ALTER TABLE silo_definitions ENABLE TRIGGER silo_definitions_immutable_once_published;
