-- 036_maps — the learned layer.
--
-- ── What makes the system get smarter without storing business data ─────────
--
-- §6.1: references, counts and dispositions. NO VALUES, EVER. Read every table
-- below for a column that could hold something read out of a customer's record
-- and there is none — ids, names, counts, weights and timestamps. That is the
-- same structural guarantee 019 makes about discovery and 030 makes about
-- proposals, and it is what lets §6.1 say a map holds even with Siloes off: the
-- learning layer never depended on storage, because it never learned from data.
--
-- ── Per user, not per organisation ─────────────────────────────────────────
--
-- §6.2. A lawyer and an engineer in the same company use the same data
-- differently, weight different concepts and dismiss different findings. One
-- shared map would average them into something useful to neither — so the owner
-- is a membership, and everything hanging off a map inherits that.
--
-- ── No cross-tenant learning ───────────────────────────────────────────────
--
-- §6.5. Every table here carries an organisation and every one has row level
-- security forcing it. There is no anonymised layer and no aggregate across
-- customers, and this costs something real: proposals would be better with
-- cross-tenant signal. It is not worth the answer it forces in front of a
-- defence or banking customer, where the question is asked directly and
-- anything other than "never" ends the conversation.

/*
 * ── The sharing policy ─────────────────────────────────────────────────────
 *
 * §6.4 says the policy governing views governs maps. There is no views table in
 * this codebase yet, so this column has one reader today and is deliberately
 * named for neither — when saved views land they read THIS column rather than
 * adding a second one, because two settings called "sharing policy" that can
 * disagree is how a customer ends up with a policy they did not set.
 *
 * `explicit_only` IS THE DEFAULT, matching "private by default" in §6.3. An
 * organisation that wants open sharing turns it on having read what it means.
 */
ALTER TABLE organisations
  ADD COLUMN sharing_policy text NOT NULL DEFAULT 'explicit_only'
    CHECK (sharing_policy IN ('open', 'scope_only', 'explicit_only', 'disabled'));

CREATE TABLE maps (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,

  /* §6.2 — a membership, and that is the whole design decision. */
  owner_membership_id uuid    NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),

  /*
   * THE DEFAULT ONE, NOT THE ONLY ONE IN USE. §6.3 says the active map is chosen
   * per session or per investigation; this is what a session gets when it has
   * not chosen. A person keeping separate maps for separate kinds of work still
   * has one they land on.
   */
  active          boolean     NOT NULL DEFAULT false,

  /*
   * §6.4 — COPY FORKS. A recipient with copy access takes a snapshot that then
   * learns independently, and their dismissals do not affect the original.
   * Keeping the link makes "where did this come from" answerable; ON DELETE SET
   * NULL because a fork outlives its parent.
   */
  forked_from     uuid        REFERENCES maps(id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,

  CONSTRAINT maps_name_unique UNIQUE (owner_membership_id, name)
);

/* One default per person. A second would be decided by row order. */
CREATE UNIQUE INDEX maps_one_active
  ON maps (owner_membership_id) WHERE active AND archived_at IS NULL;

CREATE INDEX maps_by_owner ON maps (owner_membership_id) WHERE archived_at IS NULL;

/*
 * ── Shares ─────────────────────────────────────────────────────────────────
 *
 * §6.3: shareable by name or email, WITHIN THE ORGANISATION ONLY. There is no
 * external grantee in this table and there must never be one — a map is a
 * description of how somebody reads their own company's systems.
 *
 * THE GRANTEE SHAPE IS `connection_grants`', because it is the same question and
 * two different answers to it in one database is how a permission bug hides. A
 * person, a scope, or everybody.
 */
CREATE TABLE map_shares (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  map_id          uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,

  membership_id   uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id        uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  organisation_wide boolean   NOT NULL DEFAULT false,

  CONSTRAINT map_shares_one_grantee CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int + (organisation_wide)::int = 1
  ),

  /*
   * USE OR COPY, AND THE DIFFERENCE IS WHOSE LEARNING IT IS. `use` opens the
   * owner's map and learns nothing from the opener; `copy` forks it, after which
   * the two diverge. There is no `edit`: a map somebody else's dismissals write
   * into is a map that averages two people, which is exactly what §6.2 refuses.
   */
  access          text        NOT NULL CHECK (access IN ('use', 'copy')),

  shared_by       uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  shared_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,

  CONSTRAINT map_shares_unique_grantee UNIQUE (map_id, membership_id, scope_id, organisation_wide)
);

CREATE INDEX map_shares_live ON map_shares (map_id)
  WHERE revoked_at IS NULL;

/*
 * ── Concept links ──────────────────────────────────────────────────────────
 *
 * §6.1: this concept relates to that concept, with strength and how often it
 * proved useful.
 *
 * USEFULNESS IS A COUNT OF ACTIONS, NOT A MODEL'S OPINION. A link reinforced
 * because somebody followed it and did something is the signal; one reinforced
 * because it was drawn on a screen is noise with a number attached.
 */
CREATE TABLE map_links (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  map_id          uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,

  concept_a       uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  concept_b       uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /* Canonical order, so one pair is one row — the same reasoning 033 spells out
     at length for associations. */
  CONSTRAINT map_links_canonical_order CHECK (concept_a < concept_b),
  CONSTRAINT map_links_unique UNIQUE (map_id, concept_a, concept_b),

  strength        numeric(4,3) NOT NULL DEFAULT 0 CHECK (strength BETWEEN 0 AND 1),
  usefulness_count integer     NOT NULL DEFAULT 0 CHECK (usefulness_count >= 0),

  last_reinforced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX map_links_by_map ON map_links (map_id, strength DESC);

/*
 * ── Detector weights ───────────────────────────────────────────────────────
 *
 * §6.1: this detector on this concept is usually signal, or usually noise.
 *
 * §6.6 — IT NEVER CHANGES WHAT A DETECTOR COMPUTES. The weight affects ranking
 * and connector selection. Detection stays arithmetic, the same data produces
 * the same findings, and a finding can always be explained by showing the
 * subtraction — which stops being true the moment a learned weight reaches
 * inside the computation.
 *
 * SIGNAL AND NOISE ARE BOTH COUNTED. A weight alone cannot say whether it came
 * from two decisions or two hundred, and a ranking layer that cannot tell those
 * apart will trust a new map as much as a seasoned one.
 */
CREATE TABLE map_detector_weights (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  map_id          uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,

  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  detector        text        NOT NULL,

  /* One is neutral. Below one this map has learned to look at it less. */
  weight          numeric(5,3) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 10),
  signal_count    integer     NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  noise_count     integer     NOT NULL DEFAULT 0 CHECK (noise_count >= 0),

  last_adjusted_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT map_detector_weights_unique UNIQUE (map_id, concept_id, detector)
);

/*
 * ── Connector relevance ────────────────────────────────────────────────────
 *
 * §6.1: this question shape draws on these connections.
 *
 * A HASH OF THE SHAPE, NOT THE QUESTION. Storing the question would put the
 * customer's own words — which routinely contain a supplier name, a person, an
 * amount — into the learned layer, and §6.1 says no values ever. The hash is
 * enough to recognise the same shape again and carries nothing back.
 */
CREATE TABLE map_connector_relevance (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  map_id          uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,

  query_pattern_hash text     NOT NULL CHECK (length(query_pattern_hash) BETWEEN 16 AND 128),
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE CASCADE,

  hit_count       integer     NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  last_used_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT map_connector_relevance_unique UNIQUE (map_id, query_pattern_hash, connection_id)
);

CREATE INDEX map_connector_relevance_lookup
  ON map_connector_relevance (map_id, query_pattern_hash, hit_count DESC);

/*
 * ── Thresholds ─────────────────────────────────────────────────────────────
 *
 * §3.4: deterministic first, tuned by the model, then persisted — against the
 * concept and detector IN THE MAP, which is why this table lives here and not
 * beside `findings`.
 *
 * `origin` IS THE WHOLE POINT OF KEEPING IT. A threshold that has been through
 * the loop several times is used directly on the next run rather than
 * re-derived; one that has not is a first guess and should be re-derived when
 * the population changes. Without the column both look identical.
 *
 * NOTHING BREAKS WHEN THIS TABLE IS EMPTY. §3.4 — an initial threshold comes
 * from the query itself, so a newly connected system produces sensible findings
 * with no row here at all. That is what makes this an optimisation rather than
 * a configuration step.
 */
CREATE TABLE thresholds (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  map_id          uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,

  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  detector        text        NOT NULL,

  value           numeric     NOT NULL,
  origin          text        NOT NULL CHECK (origin IN ('derived', 'tuned')),
  run_count       integer     NOT NULL DEFAULT 0 CHECK (run_count >= 0),

  last_adjusted_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT thresholds_unique UNIQUE (map_id, concept_id, detector)
);

-- ── Row level security ──────────────────────────────────────────────────────

ALTER TABLE maps                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE maps                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE map_shares               ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_shares               FORCE  ROW LEVEL SECURITY;
ALTER TABLE map_links                ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_links                FORCE  ROW LEVEL SECURITY;
ALTER TABLE map_detector_weights     ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_detector_weights     FORCE  ROW LEVEL SECURITY;
ALTER TABLE map_connector_relevance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_connector_relevance  FORCE  ROW LEVEL SECURITY;
ALTER TABLE thresholds               ENABLE ROW LEVEL SECURITY;
ALTER TABLE thresholds               FORCE  ROW LEVEL SECURITY;

/*
 * TENANT ONLY, NOT OWNER. §6.5 is what these policies enforce: a map never
 * leaves its organisation. WHO within the organisation may open one is §6.3 and
 * §6.4 — private by default, shared explicitly, re-checked against the opener's
 * own permissions — and that is a decision about grants and markings which a
 * row level policy cannot make. The service holds it, because the service is
 * where `readableIds` and the marking check already live.
 */
CREATE POLICY maps_tenant ON maps
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY map_shares_tenant ON map_shares
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY map_links_tenant ON map_links
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY map_detector_weights_tenant ON map_detector_weights
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY map_connector_relevance_tenant ON map_connector_relevance
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

CREATE POLICY thresholds_tenant ON thresholds
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON maps                    TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON map_shares              TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON map_links               TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON map_detector_weights    TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON map_connector_relevance TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON thresholds              TO silo_app;
