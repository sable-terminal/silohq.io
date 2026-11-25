/*
 * §2.3 — a correction to what a system calls something, kept for next time.
 *
 * ── What this exists to stop somebody redoing ──────────────────────────────
 *
 * Canonicalisation is mechanical: `Invoice.TotalAmt` becomes `total` by taking
 * the object's own name out of the field's and singularising what is left. It
 * is right often and it is not right always — a system whose column is
 * `amt_gross` canonicalises to `amt_gross`, and a person has to say that it is
 * the concept's `total`.
 *
 * Today that correction would be written into ONE concept's field map and lost
 * to the next concept over the same system. A customer with an invoice concept
 * and a credit note concept over the same ERP would say it twice, and a third
 * time when they add payments.
 *
 * ── It belongs to the CONNECTION, not to the concept ───────────────────────
 *
 * "This system's `amt_gross` means `total`" is a fact about a vendor's schema.
 * "These objects across these systems mean one thing" is a fact about a
 * business. The first is the same for every concept over that connection, so it
 * is stored once against the connection and every concept over it inherits.
 *
 * ── And NOT to the connector, which is the tempting mistake ────────────────
 *
 * A connector describes one system without reference to any other, and it is
 * shared: a correction stored there would reach every customer on that
 * connector. The canonicalisation is already identical for all of them because
 * it is derived from the manifest; a CORRECTION is somebody's judgement about
 * their own estate, and §2.1's rule that nothing is predefined is exactly the
 * rule against letting one customer's judgement shape another's derivation.
 *
 * ── One live alias per source field ────────────────────────────────────────
 *
 * The source field is the key, because that is the thing being renamed. Two
 * canonical names for one column is a contradiction; two columns mapping to one
 * canonical name is legitimate and common, and the unique constraint permits it.
 */

CREATE TABLE field_aliases (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),
  /** What the source calls it. */
  source_field    text        NOT NULL CHECK (length(trim(source_field)) BETWEEN 1 AND 256),
  /** What the organisation calls it, in a concept's terms. */
  canonical_field text        NOT NULL CHECK (length(trim(canonical_field)) BETWEEN 1 AND 256),

  declared_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  declared_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT field_aliases_unique UNIQUE (connection_id, object_name, source_field)
);

CREATE INDEX field_aliases_by_connection ON field_aliases (connection_id, object_name);

ALTER TABLE field_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_aliases FORCE  ROW LEVEL SECURITY;

CREATE POLICY field_aliases_tenant ON field_aliases
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON field_aliases TO silo_app;
