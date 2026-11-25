-- 032_findings — what the detectors computed.
--
-- ── A finding is arithmetic, not an opinion ─────────────────────────────────
--
-- §3.3. Every column here is something a detector calculated, and a finding can
-- always be explained by showing the computation. No model participates in
-- producing one; the model comes later and may only reorder what is already
-- here (§5.2).
--
-- ── The line this file must not cross ───────────────────────────────────────
--
-- `entity_ref` IS AN IDENTIFIER, NEVER A VALUE. §3.2 is explicit: "which
-- instance, by identifier not value". `observed` and `expected` are the two
-- exceptions and they are numeric on purpose — a disagreement between two
-- systems IS a pair of numbers, and a finding that cannot say which two is not
-- a finding. Everything else about the entity stays in the customer's systems.
--
-- `evidence` AND `lineage` CARRY REFERENCES. Which records contributed, by id;
-- which source, field path and connector version each figure came from. A user
-- challenging a finding is shown the computation and then sent to the records —
-- not handed a copy of them.

CREATE TABLE findings (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /*
   * THE TEN OF §3, AS A CHECK RATHER THAN A LOOKUP TABLE. The set is closed by
   * the spec and changes only when the spec does; a table would suggest a
   * customer could add one, and a detector nobody wrote cannot emit anything.
   */
  detector        text        NOT NULL CHECK (detector IN (
                                'disagreement', 'absence', 'duplication',
                                'referential_break', 'sequence_violation',
                                'outlier', 'concentration',
                                'timing_deviation', 'drift', 'recurrence')),

  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /** Which instance, by identifier. Never by value. */
  entity_ref      text        NOT NULL CHECK (length(trim(entity_ref)) BETWEEN 1 AND 512),

  /** What was examined — a field path on the concept. */
  measure         text        NOT NULL CHECK (length(trim(measure)) BETWEEN 1 AND 256),

  observed        numeric,
  expected        numeric,

  /*
   * NORMALISED, SO TEN FINDINGS CAN BE ORDERED AGAINST EACH OTHER. A £4
   * difference on £8 and a £4,000 difference on £4,000,000 are not the same
   * event, and a ranking layer reading raw magnitudes would put the second
   * first every time.
   */
  deviation       numeric,

  /*
   * WHAT IT WAS COMPARED AGAINST, AND HOW MANY. §4.1 says sample size is stated
   * always; this is where "always" is enforced, because a finding with no
   * population is an assertion.
   */
  population      jsonb       NOT NULL DEFAULT '{}',
  population_n    integer     NOT NULL CHECK (population_n >= 0),

  evidence        jsonb       NOT NULL DEFAULT '[]',
  lineage         jsonb       NOT NULL DEFAULT '[]',

  confidence      numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),

  detected_at     timestamptz NOT NULL DEFAULT now(),

  /*
   * THE SAME FACT, FOUND TWICE, IS ONE ROW. A detector re-running over
   * unchanged data must not produce a second finding — the dismissal somebody
   * made yesterday would stop applying, and the list would grow every time
   * anybody asked a question. `detected_at` moves; the row does not.
   */
  CONSTRAINT findings_unique UNIQUE (organisation_id, detector, concept_id, entity_ref, measure)
);

CREATE INDEX findings_by_concept ON findings (organisation_id, concept_id, detected_at DESC);
CREATE INDEX findings_recent ON findings (organisation_id, detected_at DESC);

/*
 * ── Disposition ────────────────────────────────────────────────────────────
 *
 * §3.2: "Disposition ships from day one even though nothing consumes it
 * initially. It is the only route from generic detection to learned
 * significance, and retrofitting it means losing the history that makes it
 * useful."
 *
 * PER MEMBERSHIP, NOT PER ORGANISATION. §6.6 — silenced for the person, not for
 * everybody. One user dismissing a finding does not remove it from a
 * colleague's view, because the two of them are not looking for the same thing;
 * that is the same argument §6.2 makes for maps being per user.
 *
 * A REASON, ON DISMISSAL. §9: `finding_dismissed` carries it, and it is doing
 * two jobs — the feedback signal that teaches ranking, and the evidence that a
 * person saw this and judged it, which is what matters if the finding later
 * turns out to have been important.
 */
CREATE TABLE finding_dispositions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  finding_id      uuid        NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  disposition     text        NOT NULL CHECK (disposition IN ('confirmed', 'dismissed', 'not_relevant')),
  reason          text        CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000),

  decided_at      timestamptz NOT NULL DEFAULT now(),

  /* One standing opinion per person per finding; changing it replaces it. */
  CONSTRAINT finding_dispositions_one_per_person UNIQUE (finding_id, membership_id),

  /*
   * DISMISSAL EXPLAINS ITSELF. Confirming needs no words — the finding already
   * says what it is — but "this is not worth looking at" is the judgement that
   * later needs defending, and an unexplained one is indistinguishable from a
   * misclick.
   */
  CONSTRAINT finding_dispositions_dismissal_explained CHECK (
    disposition <> 'dismissed' OR reason IS NOT NULL
  )
);

CREATE INDEX finding_dispositions_by_person ON finding_dispositions (membership_id, decided_at DESC);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE findings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings              FORCE  ROW LEVEL SECURITY;
ALTER TABLE finding_dispositions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_dispositions  FORCE  ROW LEVEL SECURITY;

CREATE POLICY findings_tenant ON findings
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY finding_dispositions_tenant ON finding_dispositions
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON findings             TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON finding_dispositions TO silo_app;
