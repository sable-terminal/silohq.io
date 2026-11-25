-- 048_finding_links — the outbound references a row carried, as the source
-- stated them.
--
-- ── Why the raw value and not the resolved entity ──────────────────────────
--
-- A finding names one entity. Relating it to a finding about a DIFFERENT
-- concept — a late order and its disputed invoice — needs to know which invoice
-- belonged to which order, and a finding carried its own reference and nothing
-- else. Association was left inferring the link from whether two findings
-- happened to share an entity reference, which is not a relationship.
--
-- The obvious shape is to resolve the foreign key at detection time and store
-- the concept entity it points at. That is wrong, and the reason is worth
-- keeping:
--
--   IT COUPLES DETECTION TO THE RESOLVER. A detector's job is arithmetic over
--   rows; resolution is a separate act with its own confirmed pairs, its own
--   corrections and its own history.
--
--   AND IT IS NOT RECOVERABLE. Somebody confirms in September that `ACME GROUP
--   LIMITED` is `Acme Group Ltd`. Every finding written in March resolved that
--   key to nothing, and a stored resolution cannot be repaired — the raw value
--   it came from is gone. Stored raw, March's findings resolve correctly the
--   moment the pair is confirmed, because resolution happens at READ time
--   against whatever is known then.
--
-- So: the connection, the object, the field, and the value exactly as the
-- source stated it. Resolution is a separate step and always re-runnable.
--
-- ── Every outbound link, not the one that looked relevant ──────────────────
--
-- The row is in hand once, during a detector run that already paid to fetch it.
-- Which link matters is decided later, by whatever question somebody asks —
-- and going back for the others means the re-fetch this table exists to avoid.
-- So every relationship the manifest declares on that object, for which the row
-- holds a value, is captured.
--
-- ── What this is, and what it is not ───────────────────────────────────────
--
-- `value` IS CUSTOMER DATA. It is an IDENTIFIER — a supplier code, an order
-- number, a customer key — which is the same class of thing `findings.entity_ref`
-- already holds, and §3.2 permits exactly that: "which instance, by identifier
-- not value".
--
-- IT IS NOT PERMISSION TO STORE THE REST OF THE ROW. The row is in hand at
-- capture time and every other field on it is a business value: a balance, a
-- name, a note, a date of birth. Nothing but declared foreign keys belongs
-- here, and there is no column for anything else. If a later change wants one,
-- that is the no-data-stored line being crossed, and it should be argued
-- explicitly rather than added because the data happened to be nearby.

CREATE TABLE finding_links (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  finding_id      uuid        NOT NULL REFERENCES findings(id) ON DELETE CASCADE,

  /* Where it was read. A foreign key is a statement inside one system. */
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  from_object     text        NOT NULL CHECK (length(trim(from_object)) BETWEEN 1 AND 128),
  field           text        NOT NULL CHECK (length(trim(field)) BETWEEN 1 AND 256),

  /*
   * THE VALUE AS THE SOURCE STATED IT. Not trimmed, not case-folded, not
   * resolved. Normalisation is the resolver's business and its rules change;
   * a stored value that was already normalised cannot be re-normalised
   * differently later.
   */
  value           text        NOT NULL CHECK (length(value) BETWEEN 1 AND 512),

  /*
   * WHAT THE MANIFEST SAID IT POINTED AT, AT CAPTURE TIME. Read-time resolution
   * needs to know where to look, and the manifest it would consult today may
   * describe a schema that has since changed. Storing it is what lets a finding
   * written in March still say which object its key was meant to reach.
   *
   * These are schema — an object name and a field name — not data.
   */
  target_object   text        NOT NULL CHECK (length(trim(target_object)) BETWEEN 1 AND 128),
  target_field    text        NOT NULL CHECK (length(trim(target_field)) BETWEEN 1 AND 256),

  captured_at     timestamptz NOT NULL DEFAULT now(),

  /* One value per field per finding: a row holds one value in a column. */
  CONSTRAINT finding_links_unique UNIQUE (finding_id, connection_id, field)
);

/* The walk: given a finding, what did its row point at. */
CREATE INDEX finding_links_by_finding ON finding_links (finding_id);

/*
 * And the reverse, which is the join association actually needs: given a target
 * object and a value, which findings pointed at it. Without this, relating two
 * concepts is a sequential scan over every link ever captured.
 */
CREATE INDEX finding_links_inbound
  ON finding_links (organisation_id, connection_id, target_object, value);

ALTER TABLE finding_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_links FORCE  ROW LEVEL SECURITY;

CREATE POLICY finding_links_tenant ON finding_links
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON finding_links TO silo_app;
