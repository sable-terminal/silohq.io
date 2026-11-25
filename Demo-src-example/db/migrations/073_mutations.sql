/*
 * 073 — mutations, as far as the preview: what was asked, what it resolved to,
 * what every affected record held before, and the diff.
 *
 * ── Why these three tables come first ──────────────────────────────────────
 *
 * Mutations §17: "The first two are the ones that cannot be added
 * retrospectively, since every write performed without them is unauditable and
 * unrevertable." A write made before `prior_states` existed can never be
 * reverted, because what the record said before is gone. So the record of what
 * is about to change is built, and tested, before anything is allowed to change.
 *
 * NOTHING HERE WRITES TO A SOURCE. Approval, execution, the receipt and revert
 * each arrive in their own migration, on top of rows these tables already hold.
 *
 * ── What is stored, and for how long ───────────────────────────────────────
 *
 * VALUES, BOUNDED BY THE SCHEMA. The manifest holds the new values, the preview
 * and `prior_states` hold the old ones. None of it is kept past `expires_at`: a
 * mutation not carried through by then is discarded by the retention sweep,
 * rows and all, and the bound on `expires_at` is a constraint rather than a
 * setting, because "no data stored permanently" is a claim about the schema.
 *
 * ONLY THE FIELDS THE MUTATION TOUCHES, PLUS THE IDENTIFIER (§6). Not the
 * record. A table that kept whole rows "to be safe" would be a copy of the
 * customer's systems that nobody decided to make.
 */

/* ── A proposed change ───────────────────────────────────────────────────── */

/*
 * `manifest` IS THE INTENT, VALIDATED. The concept, the entity set as filters in
 * the concept's own field names, the fields, the new values and the operation —
 * never a table or a column, which the user does not name (§3).
 *
 * `preview` IS THE DIFF, COMPUTED ONCE (§8). Every place that shows it — the
 * console, the approvals queue, the receipt — reads this column, so no two of
 * them can render it differently. `preview_digest` is its SHA-256, which is what
 * the audit trail carries in place of the values.
 *
 * `resolution` IS PER MUTATION AND NEVER PER ORGANISATION (§7). There is no
 * organisation setting for it anywhere, and there must not be one: a default
 * somebody switched to `partial` once would silently exclude records from every
 * change made afterwards.
 */
CREATE TABLE mutations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
  intent          text        NOT NULL CHECK (length(trim(intent)) BETWEEN 1 AND 2000),
  manifest        jsonb       NOT NULL,
  operation       text        NOT NULL CHECK (operation IN ('update', 'delete')),
  resolution      text        NOT NULL DEFAULT 'strict' CHECK (resolution IN ('strict', 'partial')),
  status          text        NOT NULL DEFAULT 'previewed'
                    CHECK (status IN ('previewed')),
  proposed_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  preview         jsonb       NOT NULL,
  preview_digest  text        NOT NULL CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
  records         integer     NOT NULL CHECK (records >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  /*
   * THE BOUND ON HOW LONG A CHANGE NOBODY CARRIED THROUGH IS KEPT. A plan
   * computed against data as it stood must not run against a world that has
   * moved (§9), and what it read must not outlive the reason it was read.
   */
  CONSTRAINT mutations_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX mutations_by_status ON mutations (organisation_id, status, created_at DESC);
CREATE INDEX mutations_expiring ON mutations (expires_at);

ALTER TABLE mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutations FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutations_tenant ON mutations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * NO DELETE. Discarding a mutation is the retention sweep's, which connects as
 * the migrator; the application cannot make one disappear.
 */
GRANT SELECT, INSERT, UPDATE ON mutations TO silo_app;

/*
 * WHAT WAS PREVIEWED IS WHAT IS APPROVED. `status` moves; nothing that describes
 * the change does. An UPDATE grant is needed for the status, and without this an
 * UPDATE could also swap the values under a pending approval — which is the
 * exact abuse §9's snapshot rule exists to prevent, arriving by another door.
 */
CREATE OR REPLACE FUNCTION mutations_describe_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
  OR NEW.concept_id      IS DISTINCT FROM OLD.concept_id
  OR NEW.intent          IS DISTINCT FROM OLD.intent
  OR NEW.manifest        IS DISTINCT FROM OLD.manifest
  OR NEW.operation       IS DISTINCT FROM OLD.operation
  OR NEW.resolution      IS DISTINCT FROM OLD.resolution
  OR NEW.proposed_by     IS DISTINCT FROM OLD.proposed_by
  OR NEW.preview         IS DISTINCT FROM OLD.preview
  OR NEW.preview_digest  IS DISTINCT FROM OLD.preview_digest
  OR NEW.records         IS DISTINCT FROM OLD.records
  OR NEW.created_at      IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A mutation is described once; only its status and expiry move'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mutations_describe_once
  BEFORE UPDATE ON mutations
  FOR EACH ROW EXECUTE FUNCTION mutations_describe_once();

/* ── Which records, in which systems ─────────────────────────────────────── */

/*
 * ONE ROW PER RECORD PER SYSTEM. An entity spans connections, so one intent
 * becomes several per-connection plans (§4); `entity` groups a mutation's rows
 * back into the entities they are.
 *
 * `entity` IS AN ORDINAL, NOT THE MATCH KEY. The key is usually a value — an
 * invoice number, an email address — and the grouping needs no value to work.
 *
 * `identifier` IS EVERY FIELD THE SYSTEM IDENTIFIES THE RECORD BY. A composite
 * key is ordinary in finance systems, and a write matching on half of one hits
 * the wrong row.
 */
CREATE TABLE mutation_targets (
  mutation_id     uuid        NOT NULL REFERENCES mutations(id) ON DELETE CASCADE,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  entity          integer     NOT NULL CHECK (entity >= 0),
  ref             text        NOT NULL CHECK (length(ref) BETWEEN 1 AND 1000),
  identifier      jsonb       NOT NULL CHECK (jsonb_typeof(identifier) = 'object'),
  operation       text        NOT NULL CHECK (operation IN ('update', 'delete')),
  fields          text[]      NOT NULL,
  resolved_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mutation_id, connection_id, ref)
);

ALTER TABLE mutation_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_targets FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_targets_tenant ON mutation_targets
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* APPEND-ONLY. A target that could be edited after the preview is a write to a
   record nobody approved. */
GRANT SELECT, INSERT ON mutation_targets TO silo_app;

/* ── What each record held before ────────────────────────────────────────── */

/*
 * THE STAGE THAT CANNOT BE ADDED LATER (§6). Read before anything is written,
 * through the same bounded query path as an answer, and kept one field per row
 * so that a revert compares field by field and a conflict on one field does not
 * block the rest.
 *
 * `value` IS JSONB, AND A NULL IS JSON `null`, NOT A MISSING ROW. "It was empty"
 * and "we did not read it" are different statements, and a revert restoring the
 * first must never be confused with the second.
 *
 * `column_name` IS LINEAGE: which field of that system the value came from,
 * which the receipt names beside the connector version.
 */
CREATE TABLE prior_states (
  mutation_id     uuid        NOT NULL,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL,
  ref             text        NOT NULL,
  field           text        NOT NULL CHECK (length(field) BETWEEN 1 AND 200),
  column_name     text        NOT NULL CHECK (length(column_name) BETWEEN 1 AND 200),
  value           jsonb       NOT NULL,
  read_at         timestamptz NOT NULL,
  PRIMARY KEY (mutation_id, connection_id, ref, field),
  FOREIGN KEY (mutation_id, connection_id, ref)
    REFERENCES mutation_targets (mutation_id, connection_id, ref) ON DELETE CASCADE
);

ALTER TABLE prior_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE prior_states FORCE  ROW LEVEL SECURITY;
CREATE POLICY prior_states_tenant ON prior_states
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* APPEND-ONLY, for the reason a revert depends on: what a record held before is
   evidence, and evidence that can be edited is not. */
GRANT SELECT, INSERT ON prior_states TO silo_app;
