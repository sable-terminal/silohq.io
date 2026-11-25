/*
 * §2.8 — which system is right about a field, when they disagree.
 *
 * ── The question at the centre of every cross-system answer ────────────────
 *
 * A concept says `invoices` in Netsuite and `Invoice` in Sage mean one thing.
 * Resolution says which rows are the same invoice. Then Netsuite says the total
 * is £200 and Sage says £260, and every question above that point has to know
 * what to do about it.
 *
 * TODAY THE ANSWER IS "REPORT BOTH AND DECIDE NOTHING", which is right for a
 * FINDING — a disagreement detector that picked a side would be inventing the
 * answer it was asked to look for. It is not an answer to "what did we spend
 * with Acme". A total cannot carry two readings; something has to choose, and
 * the only thing entitled to choose is the customer.
 *
 * ── Why this is a table and not a rule ─────────────────────────────────────
 *
 * NOTHING IN THIS PRODUCT CAN WORK OUT WHICH SYSTEM IS RIGHT, and every
 * heuristic that looks like it can is wrong somewhere expensive. Most recently
 * written is wrong when a nightly sync overwrites a correction. Highest
 * precision is wrong when one system rounds deliberately. The system with more
 * rows is wrong when it is the stale one.
 *
 * So a person states it, the same way §2.4 makes a person confirm a concept and
 * §4.2 makes a person designate an outcome. This table is that statement.
 *
 * ── One live answer per field ──────────────────────────────────────────────
 *
 * Two authorities for one field is a contradiction rather than a richer
 * configuration: the merge would have to pick between the pickers. The unique
 * constraint covers retired rows too, which is deliberate — see below.
 *
 * ── Retired, never deleted ─────────────────────────────────────────────────
 *
 * Every answer anybody was given while a designation stood was merged by it. A
 * row that vanishes makes those answers unexplainable — somebody asks why last
 * quarter's total differs from this quarter's and the reason is no longer in
 * the database. `outcome_designations` draws this exact line for the same
 * reason and this follows it.
 */

CREATE TABLE field_authorities (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /*
   * THE CONCEPT'S NAME FOR THE FIELD, NOT ANY SYSTEM'S. `total` rather than
   * `Invoice.TotalAmt`, because the whole point is that one statement covers
   * every system the concept spans — including systems added later, which do
   * not exist yet and cannot be named here.
   */
  field_path      text        NOT NULL CHECK (length(trim(field_path)) BETWEEN 1 AND 256),

  /*
   * ── The system whose reading wins, and the constraint that makes it real ──
   *
   * THE COMPOSITE FOREIGN KEY IS THE POINT OF THIS COLUMN. It references
   * `concept_objects (concept_id, connection_id)`, so the database refuses an
   * authority declared for a system the concept does not actually span. The
   * alternative — a plain reference to `connections` — would accept "Sage is
   * authoritative for invoice.total" from an organisation whose invoice concept
   * has no Sage object at all, and the merge would silently never find a
   * reading to prefer.
   *
   * ON DELETE CASCADE, because correcting a concept to drop a system must take
   * the authority with it. An authority pointing at a system that no longer
   * contributes is a rule that can never fire, and one nobody would think to
   * look for.
   */
  connection_id   uuid        NOT NULL,

  /** Why this system, in the words of whoever decided. */
  because         text        CHECK (because IS NULL OR length(trim(because)) BETWEEN 1 AND 512),

  declared_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  declared_at     timestamptz NOT NULL DEFAULT now(),

  retired_at      timestamptz,

  CONSTRAINT field_authorities_spans_concept
    FOREIGN KEY (concept_id, connection_id)
    REFERENCES concept_objects (concept_id, connection_id) ON DELETE CASCADE,

  /* One answer per field, retired rows included — so re-declaring is an
     explicit retire-then-declare rather than a second row that wins by luck. */
  CONSTRAINT field_authorities_unique UNIQUE (organisation_id, concept_id, field_path)
);

CREATE INDEX field_authorities_live
  ON field_authorities (organisation_id, concept_id) WHERE retired_at IS NULL;

ALTER TABLE field_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_authorities FORCE  ROW LEVEL SECURITY;

CREATE POLICY field_authorities_tenant ON field_authorities
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON field_authorities TO silo_app;

/*
 * §2.8 — DECLARING ONE IS A DELIBERATE ACT AND NOT A DELEGABLE ONE.
 *
 * It decides what every later answer says a number IS. A scope admin who could
 * set it for their own department would be deciding the organisation's figures
 * from inside one corner of it — the same argument that makes `outcome.designate`
 * and `marking.apply` non-scopeable in 004.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('authority.declare', 'ontology', 'Say which system is right about a field', false);
