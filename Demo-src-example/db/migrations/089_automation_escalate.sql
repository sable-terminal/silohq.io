/*
 * 089 — an automation may raise something to a named person for a decision.
 *
 * ── §4: "A notify that requires acknowledgement rather than one that can be
 * ignored" ─────────────────────────────────────────────────────────────────
 *
 * Escalate is the fourth action and appears nowhere in §14's build order, which
 * is how it nearly got left behind. It is not a louder notification: the
 * difference is that it has a state, and that state is whether a named
 * membership has answered.
 *
 * ── THE ACKNOWLEDGEMENT IS A ROW, BECAUSE "REQUIRES" NEEDS SOMEWHERE TO LIVE ─
 *
 * A notification that can be ignored needs no record beyond having been sent. A
 * notification that requires acknowledgement has to be answerable later —
 * "which of these has nobody picked up" is the question the whole action
 * exists to make askable, and an email cannot answer it.
 */

CREATE TABLE automation_escalations (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  automation_id   uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  /* Which run raised it, so the finding and the escalation stay joined. */
  run_id          uuid        NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,

  /*
   * §4 — "Raise it to a named membership or scope for a decision." Exactly one,
   * for the reason `map_shares` gives: a grantee that is two things is a row
   * whose meaning depends on which column somebody read first.
   */
  membership_id   uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id        uuid        REFERENCES scopes(id) ON DELETE RESTRICT,

  CONSTRAINT automation_escalations_one_target CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int = 1
  ),

  /* What it was raised about, in the same words the run recorded. */
  because         text        NOT NULL CHECK (length(trim(because)) BETWEEN 1 AND 2000),

  raised_at       timestamptz NOT NULL DEFAULT now(),

  /*
   * NULL UNTIL SOMEBODY ANSWERS, which is the whole point of the action. The
   * acknowledger is recorded rather than inferred from the target: a scope
   * escalation is answered by one person in that scope, and which one matters.
   */
  acknowledged_by uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  acknowledged_at timestamptz,
  note            text        CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),

  CONSTRAINT automation_escalations_acknowledged_together CHECK (
    (acknowledged_by IS NULL) = (acknowledged_at IS NULL)
  )
);

/* What an escalation list asks for: mine, unanswered, oldest first. */
CREATE INDEX automation_escalations_outstanding
  ON automation_escalations (organisation_id, raised_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX automation_escalations_by_automation ON automation_escalations (automation_id);

ALTER TABLE automation_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_escalations FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_escalations_tenant ON automation_escalations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON automation_escalations TO silo_app;

ALTER TABLE automation_actions
  DROP CONSTRAINT IF EXISTS automation_actions_kind_check;

ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_kind_check CHECK (kind IN ('notify', 'mutate', 'escalate'));
