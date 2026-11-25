/*
 * 068 — prebuilt structuring definitions, and who may delete a published one.
 *
 * ── Prebuilt, and honest about what they are ──────────────────────────────
 *
 * Import §4: "Common export formats ship as definitions." These two are named
 * by their columns, not by a vendor: a definition claiming to read a particular
 * bank's export would be wrong the day that bank changed a header, and nobody
 * adopting it would know. They are starting points — adopting one copies it
 * into a draft, and a draft still has to pass a probe against the customer's
 * own file before it can be published.
 *
 * ── A published definition is immutable to the application, not the operator ──
 *
 * 067's trigger refused every delete of a published definition, including the
 * migrator's — so an organisation could never be removed and a test could never
 * tear one down. The rule it protects is that the APPLICATION cannot rewrite
 * history rows were read under; closing an account is an operator's act.
 */

INSERT INTO silo_definitions
  (id, organisation_id, definition_key, version, name, source_route, document, status, published_at)
VALUES
  (gen_random_uuid(), NULL, 'prebuilt-transactions', 1, 'Transactions (Date, Reference, Description, Amount)',
   'prebuilt', '{"schemaVersion": 1, "identity": {"name": "Transactions (Date, Reference, Description, Amount)", "description": "A starting point for a ledger or bank export with one row per transaction. Adopt it, change the column names to match your file, and test it against that file before publishing."}, "objects": [{"name": "transaction", "files": {"pattern": "*", "headerRow": 1}, "fields": [{"name": "date", "type": "date", "nullable": false, "format": "dd/mm/yyyy", "extraction": {"method": "column", "column": "Date"}}, {"name": "reference", "type": "string", "nullable": false, "format": "iso", "extraction": {"method": "column", "column": "Reference"}}, {"name": "description", "type": "string", "nullable": true, "format": "iso", "extraction": {"method": "column", "column": "Description"}}, {"name": "amount", "type": "number", "nullable": false, "format": "iso", "extraction": {"method": "column", "column": "Amount"}}], "identifier": ["reference"], "relationships": []}]}'::jsonb, 'published', now()),
  (gen_random_uuid(), NULL, 'prebuilt-contacts', 1, 'Contacts (ID, Name, Email)',
   'prebuilt', '{"schemaVersion": 1, "identity": {"name": "Contacts (ID, Name, Email)", "description": "A starting point for a customer, supplier or member export with one row per contact. Adopt it, change the column names to match your file, and test it against that file before publishing."}, "objects": [{"name": "contact", "files": {"pattern": "*", "headerRow": 1}, "fields": [{"name": "id", "type": "string", "nullable": false, "format": "iso", "extraction": {"method": "column", "column": "ID"}}, {"name": "name", "type": "string", "nullable": true, "format": "iso", "extraction": {"method": "column", "column": "Name"}}, {"name": "email", "type": "string", "nullable": true, "format": "iso", "extraction": {"method": "column", "column": "Email"}}], "identifier": ["id"], "relationships": []}]}'::jsonb, 'published', now());

CREATE OR REPLACE FUNCTION silo_definitions_refuse_edit_once_published()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' AND current_user = 'silo_app' THEN
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
