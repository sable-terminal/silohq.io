/*
 * 104 — the two things §10's build order leaves out.
 *
 * §10 lists seven steps and calls one to three "a complete and defensible
 * product". It is a build order for the ENGINE, and §5, §7 and §9 ask for two
 * things it never mentions: sharing a scenario and comparing two runs.
 *
 * Comparison needs no table — it reads two runs that are already stored, which
 * is most of why §5 keeps the question and expires the answers. Sharing does.
 *
 * ── §7: "simulation.share — Share a scenario" ─────────────────────────────
 *
 * A SHARE WIDENS WHO CAN ASK, NEVER WHAT THE ANSWER CONTAINS. §7's marking rule
 * is applied to the person RUNNING — "a simulation whose path crosses a concept
 * the runner lacks clearance for stops at that edge and reports it" — so a
 * scenario shared with somebody who holds less clearance gives them a shorter
 * answer rather than a fuller one. That is the whole reason a scenario can be
 * shared and its results cannot: results name records, and a stored answer
 * would carry the owner's clearance with it.
 *
 * ── REVOKED, NOT DELETED ──────────────────────────────────────────────────
 *
 * §9 audits `scenario_shared`, and a trail that records the grant and loses the
 * withdrawal answers "who could see this" wrongly for every date in between.
 */

CREATE TABLE scenario_shares (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  scenario_id     uuid        NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,

  /* One person at a time. An organisation-wide share would be a different
     decision with different consequences, and giving both to one column is how
     the narrower one stops being checked. */
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,

  granted_by      uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,

  /* Sharing a scenario with its own owner is a no-op that would then appear in
     a list of who it was shared with. */
  CONSTRAINT scenario_shares_not_self CHECK (membership_id <> granted_by)
);

CREATE UNIQUE INDEX scenario_shares_live
  ON scenario_shares (scenario_id, membership_id) WHERE revoked_at IS NULL;

CREATE INDEX scenario_shares_to ON scenario_shares (membership_id) WHERE revoked_at IS NULL;

ALTER TABLE scenario_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_shares FORCE  ROW LEVEL SECURITY;
CREATE POLICY scenario_shares_tenant ON scenario_shares
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON scenario_shares TO silo_app;
