-- 039_concept_lifecycle — correcting a concept, marking it, and the resolutions
-- a person confirmed.
--
-- ── What 030 left out ───────────────────────────────────────────────────────
--
-- 030 built concepts, their contributing objects, proposals and unresolved
-- pairs. It did not build the three things that make a concept usable for the
-- rest of its life:
--
--   * a way to correct one. `retired_at` was read in three queries and written
--     by nothing. A concept confirmed wrongly in March could not be renamed,
--     re-keyed, re-scoped or retired without SQL — and the concept view exists
--     precisely so somebody can fix a bad mapping months later.
--
--   * a place for its markings. §2.5 says a concept carries them, and
--     `markingCheck.util.requiredMarkings()` already takes a `concepts`
--     argument, which nothing has ever supplied.
--
--   * a home for confirmed resolutions. §2.6 promotes a decided pair into an
--     exact mapping that is "never inferred again"; without somewhere to put
--     it, resolution would have to walk the proposal history on every query.

/*
 * ── The dead table ─────────────────────────────────────────────────────────
 *
 * 004 created `concept_markings` and NOTHING HAS EVER READ OR WRITTEN IT. Two
 * test-cleanup statements name it and that is all. `resource_markings` in the
 * same migration already carries `resource_type IN (..., 'concept', ...)`, and
 * `assertCleared` reads concept markings from there.
 *
 * TWO HOMES FOR ONE FACT IS A SECOND ANSWER WAITING TO DISAGREE WITH THE FIRST,
 * and the one the authorisation layer reads is the one that decides whether
 * somebody sees a restricted record. A dead table beside it is worse than
 * useless: it is an invitation for the next person to write the marking into
 * the half nothing enforces.
 *
 * Its `concept_id` is `text`, not a foreign key, which is the other reason to
 * prefer `resource_markings` — that column would never have told anybody which
 * concept had gone.
 */
DROP TABLE IF EXISTS concept_markings;

/*
 * ── The name constraint was the wrong shape ────────────────────────────────
 *
 * `concepts_name_unique` was UNIQUE (organisation_id, name) over every row,
 * retired ones included. Two consequences, and the second is the one that
 * matters:
 *
 *   It closed the confirm-time race, which the service's SELECT-then-INSERT
 *   could not — but as a raw 23505 rather than the sentence the service had
 *   ready to explain it.
 *
 *   AND IT MADE RETIREMENT A ONE-WAY DOOR. Retire a concept called "supplier"
 *   because its match keys were wrong, and nobody can ever confirm a corrected
 *   "supplier" again. The correction path this migration exists to build would
 *   have been unusable on its first use.
 *
 * Partial, so a name is unique among the LIVE ones and a retired concept keeps
 * its name in the record where the audit trail needs it.
 */
ALTER TABLE concepts DROP CONSTRAINT concepts_name_unique;

CREATE UNIQUE INDEX concepts_name_live
  ON concepts (organisation_id, name) WHERE retired_at IS NULL;

/*
 * ── Revisions ──────────────────────────────────────────────────────────────
 *
 * A concept is not a setting. Every answer anybody has ever been given about
 * two systems agreeing was computed against the match keys that were in force
 * at the time — so a rename, a re-key, an added object or a retirement changes
 * what PAST answers meant, not just future ones.
 *
 * AN IN-PLACE UPDATE WOULD ERASE THAT. "Why did this report say 400 in March
 * and 380 now" has no answer if the only record is the current row. This table
 * is what makes it answerable, and it is why corrections go through a service
 * function rather than an UPDATE.
 *
 * NO VALUES HERE EITHER. The state columns hold names, field paths, connection
 * ids and marking ids — what a concept IS, never what any record said.
 */
CREATE TABLE concept_revisions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /*
   * WHAT KIND OF CHANGE, as a closed set. A reader asking "has anything about
   * identity changed" wants `match_keys_changed` and `objects_changed` and not
   * the eleven renames in between, and a free-text column cannot be filtered on.
   */
  change          text        NOT NULL CHECK (change IN (
                                'renamed', 'objects_changed', 'markings_changed', 'retired')),

  previous_state  jsonb       NOT NULL DEFAULT '{}',
  new_state       jsonb       NOT NULL DEFAULT '{}',

  /*
   * WHY, AND IT IS REQUIRED ON THE ONES THAT CANNOT BE UNDONE. Renaming is
   * cosmetic and explains itself; changing what two systems match on, or
   * retiring a concept other answers depended on, is a judgement somebody will
   * be asked to defend.
   */
  reason          text        CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT concept_revisions_reason_where_it_matters CHECK (
    change NOT IN ('objects_changed', 'retired') OR reason IS NOT NULL
  ),

  changed_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX concept_revisions_by_concept
  ON concept_revisions (concept_id, changed_at DESC);

/*
 * ── Confirmed resolutions ──────────────────────────────────────────────────
 *
 * §2.6. Where the exact matcher cannot match a pair it does not guess: the
 * model proposes whether the two are the same entity, a person decides, and on
 * confirmation the pair becomes an EXACT MAPPING that is never inferred again.
 * This is where the mapping lives.
 *
 * A SEPARATE TABLE FROM `unresolved_pairs`, NOT A VIEW OVER IT. Resolution
 * reads this on every query that touches the concept — it is the hot path — and
 * a view filtering a table that also holds every rejected and undecided
 * proposal gets slower exactly as a customer uses the feature more.
 *
 * REFS, NOT VALUES, and this is the line worth stating again because it looks
 * closest to being crossed here. `value_ref_a` is how the source IDENTIFIES the
 * row — an invoice number, a customer code — which §2.5 and §3.2 both permit
 * and both distinguish from what the row says. There is no column here for the
 * contents of either record.
 */
CREATE TABLE confirmed_resolutions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  connection_a    uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  value_ref_a     text        NOT NULL CHECK (length(trim(value_ref_a)) BETWEEN 1 AND 512),
  connection_b    uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  value_ref_b     text        NOT NULL CHECK (length(trim(value_ref_b)) BETWEEN 1 AND 512),

  /*
   * CANONICAL ORDER, SO ONE MAPPING IS ONE ROW. "A is B" and "B is A" are the
   * same fact; two rows for it can be decided differently and the resolver
   * would take whichever the planner returned first. The service orders the
   * pair by connection before writing, and orders it the same way before
   * reading — so the index below is the whole lookup.
   */
  CONSTRAINT confirmed_resolutions_canonical CHECK (connection_a < connection_b),
  CONSTRAINT confirmed_resolutions_unique UNIQUE (
    concept_id, connection_a, value_ref_a, connection_b, value_ref_b
  ),

  /** Which question this answered. Null where an admin mapped it directly. */
  pair_id         uuid        REFERENCES unresolved_pairs(id) ON DELETE SET NULL,

  confirmed_by    uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  confirmed_at    timestamptz NOT NULL DEFAULT now()
);

/* The hot path: given a concept and one side, find the other. */
CREATE INDEX confirmed_resolutions_lookup
  ON confirmed_resolutions (concept_id, connection_a, value_ref_a);

CREATE INDEX confirmed_resolutions_reverse
  ON confirmed_resolutions (concept_id, connection_b, value_ref_b);

/*
 * ── The same canonical rule on the questions ───────────────────────────────
 *
 * `unresolved_pairs` had a unique constraint over the ordered five-tuple, which
 * means the mirrored pair is a DIFFERENT row: the same question asked twice,
 * answerable two ways, and the resolver would take whichever came back first.
 * The ordering it happened to get came from `ORDER BY object_name` in an
 * unrelated query, which is not a guarantee of anything.
 *
 * The table is empty, so this is a constraint being added rather than data
 * being migrated.
 */
ALTER TABLE unresolved_pairs
  ADD CONSTRAINT unresolved_pairs_canonical CHECK (connection_a < connection_b);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE concept_revisions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_revisions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE confirmed_resolutions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmed_resolutions   FORCE  ROW LEVEL SECURITY;

CREATE POLICY concept_revisions_tenant ON concept_revisions
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY confirmed_resolutions_tenant ON confirmed_resolutions
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON concept_revisions     TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON confirmed_resolutions TO silo_app;
