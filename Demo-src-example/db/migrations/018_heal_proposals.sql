-- 018_heal_proposals — what self-heal wants to change, and what it may not.
--
-- THE CONSTRAINT AT THE BOTTOM IS THE POINT OF THIS FILE. §8 says a field that
-- changed MEANING halts and is not a repair, and that erring permissive
-- "silently corrupts every answer downstream". That is a rule the database can
-- hold, so it does — a service that auto-applies a semantic change is one
-- refactor away from existing, and the damage is invisible: every figure that
-- came out afterwards is wrong and nothing looks broken.

CREATE TABLE heal_proposals (
  id            uuid        PRIMARY KEY,
  connection_id uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  /*
   * Which manifest version this was noticed against. Without it a proposal
   * outlives the document it describes and applies a diff to something else.
   */
  manifest_id   uuid        NOT NULL REFERENCES connector_manifests(id) ON DELETE RESTRICT,

  change_kind   text        NOT NULL CHECK (
                  change_kind IN ('rename', 'semantic', 'new_field', 'object_removed')),

  /** What changed, named, so a person reading the queue knows without a diff. */
  subject       text        NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 256),

  proposed_diff jsonb       NOT NULL,

  /*
   * §8: a repair is sandbox-tested BEFORE it is applied. A null result means it
   * has not been tried, which is a different thing from having failed.
   */
  sandbox_status text       CHECK (sandbox_status IS NULL OR sandbox_status IN ('passed', 'failed')),
  sandbox_result jsonb,

  auto_applied  boolean     NOT NULL DEFAULT false,
  applied_at    timestamptz,
  reviewed_by   uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  reviewed_at   timestamptz,
  decision      text        CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),

  /*
   * §8: repair proposals are metered at 2 tokens. Nullable and unreferenced for
   * now — the billing subsystem does not exist, and a foreign key to a table
   * that is not built would block this migration on one that is not written.
   * It becomes an FK when metering lands.
   */
  token_transaction_id uuid,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Applying and the moment it happened travel together, or the timestamp is
  -- decoration and "when did this change" has no answer.
  CONSTRAINT heal_applied_dated CHECK (
    (auto_applied = false AND decision IS DISTINCT FROM 'accepted') OR applied_at IS NOT NULL
  ),
  CONSTRAINT heal_reviewed_pair CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL)),

  /*
   * ONLY A RENAME MAY APPLY ITSELF.
   *
   * A rename is a repair: the field is the same field with a different name, and
   * the sandbox test proves the query still returns what it did. A SEMANTIC
   * change is not a repair — the field now means something else, and applying a
   * mapping to it produces answers that are confidently wrong. An OBJECT
   * DISAPPEARING is not a repair either: a query referencing it would silently
   * return nothing, which reads as "no results" rather than "this is broken".
   *
   * `new_field` is excluded too. §8: propose mapping, never apply silently — an
   * unmapped field is invisible, and a wrongly mapped one is worse than absent.
   */
  CONSTRAINT heal_only_renames_auto_apply CHECK (
    auto_applied = false OR change_kind = 'rename'
  ),

  /*
   * AND EVEN A RENAME MUST HAVE PASSED THE SANDBOX BEFORE APPLYING ITSELF.
   *
   * `IS NOT DISTINCT FROM` RATHER THAN `=`, AND THAT IS THE WHOLE BUG THE FIRST
   * VERSION HAD. `false OR (NULL = 'passed')` evaluates to NULL, and a CHECK
   * constraint PASSES on NULL — so a proposal that had never been tested at all
   * sailed through the check written to stop exactly that. The untested case was
   * the only one it failed to catch, which is the one that matters.
   */
  CONSTRAINT heal_auto_apply_was_tested CHECK (
    auto_applied = false OR sandbox_status IS NOT DISTINCT FROM 'passed'
  )
);

CREATE INDEX heal_awaiting_review ON heal_proposals (connection_id)
  WHERE reviewed_at IS NULL AND auto_applied = false;
CREATE INDEX heal_by_connection ON heal_proposals (connection_id, created_at DESC);

ALTER TABLE heal_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE heal_proposals FORCE  ROW LEVEL SECURITY;

CREATE POLICY heal_proposals_tenant ON heal_proposals
  USING (EXISTS (SELECT 1 FROM connections c
                  WHERE c.id = connection_id AND c.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM connections c
                       WHERE c.id = connection_id AND c.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON heal_proposals TO silo_app;
