-- 014_connections — a connected instance of a connector.
--
-- `connector_manifests` IS "HOW TO TALK TO SALESFORCE". THIS IS "ACME'S
-- SALESFORCE": a manifest, a credential, an owner and a status. Nothing here
-- names a provider in code, because nothing in the engine does either.

CREATE TABLE connections (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  manifest_id     uuid        NOT NULL REFERENCES connector_manifests(id) ON DELETE RESTRICT,

  name            text        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 128),
  provider        text        NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 128),

  /*
   * PRIVATE UNTIL PROMOTED, ON EVERY ROUTE. A manifest written by a model gets
   * the same scrutiny as one written by hand — the tier is what a promotion
   * moves, never what a build route grants.
   *
   * A CHECK rather than a lookup table because the four tiers are a closed
   * ladder with behaviour attached to each rung, and `tier_rank` below depends
   * on their order.
   */
  trust_tier      text        NOT NULL DEFAULT 'private'
                    CHECK (trust_tier IN ('private', 'community', 'verified', 'certified')),

  /*
   * WHERE IN THE ORGANISATION THIS BELONGS. A connection owned by a scope is
   * administered by whoever administers that subtree, using the same containment
   * every other grant uses.
   */
  owning_scope_id      uuid   REFERENCES scopes(id) ON DELETE RESTRICT,
  owning_membership_id uuid   REFERENCES memberships(id) ON DELETE RESTRICT,

  /*
   * Who may change this connection's policy. `locked` means nobody below a super
   * admin, which is what a regulated customer sets on a system of record.
   */
  policy_authority text       NOT NULL DEFAULT 'owner_set'
                    CHECK (policy_authority IN ('owner_set', 'delegated', 'locked')),
  policy_authority_granted_to uuid REFERENCES memberships(id) ON DELETE RESTRICT,
  policy_authority_set_by     uuid REFERENCES memberships(id) ON DELETE RESTRICT,
  policy_authority_set_at     timestamptz,

  /*
   * `halted` IS A DELIBERATE STOP, NOT AN ERROR. Self-heal halts on a field that
   * changed meaning or an object that disappeared, because continuing would
   * answer questions wrongly rather than not at all. It stays halted until a
   * person looks.
   */
  status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'probing', 'verified', 'active', 'halted', 'revoked')),
  halted_reason   text,

  /*
   * WRITES ARE OFF UNTIL A SANDBOXED WRITE, VERIFY AND UNDO CYCLE PASSES, and
   * the trigger below is what makes that true rather than hoped for. Separate
   * from `status` because an active connection that may only read is the normal,
   * correct state — not a half-configured one.
   */
  writes_enabled  boolean     NOT NULL DEFAULT false,
  writes_enabled_at timestamptz,
  writes_enabled_by uuid      REFERENCES memberships(id) ON DELETE RESTRICT,

  created_by      uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_healthy_at timestamptz,

  UNIQUE (organisation_id, name),

  -- A halt that does not say why is indistinguishable from an outage, and
  -- somebody re-enables it without fixing anything.
  CONSTRAINT connections_halt_explained CHECK (status <> 'halted' OR halted_reason IS NOT NULL),

  CONSTRAINT connections_writes_dated CHECK ((writes_enabled = false) OR writes_enabled_at IS NOT NULL),

  CONSTRAINT connections_policy_delegate CHECK (
    policy_authority <> 'delegated' OR policy_authority_granted_to IS NOT NULL
  )
);

CREATE INDEX connections_by_org_status ON connections (organisation_id, status);
CREATE INDEX connections_by_scope ON connections (owning_scope_id) WHERE status <> 'revoked';
CREATE INDEX connections_by_manifest ON connections (manifest_id);

/*
 * ── Writes are switched on by verification, never by an insert ─────────────
 *
 * A ROW CANNOT BE BORN WITH WRITES ON. Without this, any code path that creates
 * a connection can hand itself mutation rights on a customer's system of record
 * by setting one boolean — bypassing §7's sandboxed write, verify and undo
 * cycle entirely. Enforced here because "the service always sets false" is a
 * property of code that somebody refactors.
 *
 * Turning writes ON is permitted on UPDATE, which is what the verification path
 * does. Turning them OFF is always permitted: revoking a capability must never
 * be harder than granting it.
 */
CREATE OR REPLACE FUNCTION connections_writes_start_disabled() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.writes_enabled THEN
    RAISE EXCEPTION
      'A connection cannot be created with writes enabled. They are switched on by verification.'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER connections_writes_off_at_birth
  BEFORE INSERT ON connections
  FOR EACH ROW EXECUTE FUNCTION connections_writes_start_disabled();

/*
 * Now that `connections` exists, the manifest immutability trigger can be
 * attached — its function references this table, so it could not be created
 * until now.
 */
CREATE TRIGGER manifests_immutable_once_used
  BEFORE UPDATE ON connector_manifests
  FOR EACH ROW EXECUTE FUNCTION manifests_refuse_edit_once_used();

/*
 * ── Promotion moves one rung at a time ─────────────────────────────────────
 *
 * §7's ladder is private → community → verified → certified. A jump from
 * private straight to certified would skip the review each rung represents, and
 * the tier is the only thing a customer has to judge a connector they did not
 * write.
 *
 * DEMOTION IS UNRESTRICTED. Taking trust away in a hurry must never be blocked
 * by a rule designed to stop trust being given away.
 */
CREATE OR REPLACE FUNCTION tier_rank(p_tier text) RETURNS integer
LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE p_tier
     WHEN 'private' THEN 0 WHEN 'community' THEN 1
     WHEN 'verified' THEN 2 WHEN 'certified' THEN 3 END $$;

CREATE OR REPLACE FUNCTION connections_promote_one_step() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF tier_rank(NEW.trust_tier) > tier_rank(OLD.trust_tier) + 1 THEN
    RAISE EXCEPTION
      'A connector is promoted one tier at a time: % cannot become % directly.',
      OLD.trust_tier, NEW.trust_tier
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER connections_tier_ladder
  BEFORE UPDATE OF trust_tier ON connections
  FOR EACH ROW EXECUTE FUNCTION connections_promote_one_step();

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE  ROW LEVEL SECURITY;

CREATE POLICY connections_tenant ON connections
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON connections TO silo_app;
GRANT EXECUTE ON FUNCTION tier_rank(text) TO silo_app;
