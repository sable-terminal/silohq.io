/*
 * 091 — the only write in the product with nobody present.
 *
 * ── §5: execute within bounds ──────────────────────────────────────────────
 *
 * "The automation writes without a person present, but only inside limits set
 * when the automation was created." §14 builds this last, "because it is the
 * only unattended write in the product", and §10 says `automation.execute`
 * "is deliberately separate and should be rare".
 *
 * ── THE BOUNDS ARE A ROW, AND THE AUTOMATION CANNOT REACH IT ───────────────
 *
 * §5 — "set at creation and unchangeable by the automation itself". So the four
 * limits live here rather than in `automation_actions.configuration`, which the
 * automation's own edit path writes. An automation that could widen its own
 * bounds has no bounds; the separation is the mechanism, not the documentation.
 *
 * ── AN EXPIRY IS MANDATORY, NOT OPTIONAL ───────────────────────────────────
 *
 * §5 lists "an expiry date on the authorisation" among the things execute mode
 * REQUIRES. NOT NULL enforces it: an authorisation to write unattended forever
 * is the one nobody revisits, and the whole point of the list is that somebody
 * reconsiders.
 *
 * ── REVOKED, NEVER DELETED ─────────────────────────────────────────────────
 *
 * §13 — `automation_executed_mutation` "is the row an auditor reads first".
 * That row names the authorisation it ran under, so deleting a withdrawn
 * authorisation would orphan the explanation for writes that already happened.
 */

CREATE TABLE automation_authorisations (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  automation_id     uuid        NOT NULL REFERENCES automations(id) ON DELETE CASCADE,

  /*
   * §5 — propose is the default and needs no authorisation, so the only mode
   * this table records is the one that writes. A `mode` column admitting
   * 'propose' would be a row that means nothing.
   */
  mode              text        NOT NULL DEFAULT 'execute_within_bounds'
                                CHECK (mode = 'execute_within_bounds'),

  /* §5 — "A maximum row count per run". */
  max_rows          integer     NOT NULL CHECK (max_rows BETWEEN 1 AND 100),

  /* §5 — "A named list of fields it may write". Empty is not "any": it is a
     misconfiguration, and the CHECK refuses it. */
  permitted_fields  text[]      NOT NULL CHECK (cardinality(permitted_fields) BETWEEN 1 AND 50),

  /* §5 — "A named set of connections it may reach". */
  permitted_connections uuid[]  NOT NULL CHECK (cardinality(permitted_connections) BETWEEN 1 AND 50),

  /* §5 — "The authorising person is recorded on every run, not just at
     creation", and this is who that person is. */
  authorised_by     uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  authorised_at     timestamptz NOT NULL DEFAULT now(),

  /* §5 — "An expiry date on the authorisation". */
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,

  CONSTRAINT automation_authorisations_expires_after CHECK (expires_at > authorised_at)
);

/*
 * ONE LIVE AUTHORISATION PER AUTOMATION. Two would mean the bounds a run
 * observed depended on which row was read first, which is the opposite of a
 * bound.
 */
CREATE UNIQUE INDEX automation_authorisations_live
  ON automation_authorisations (automation_id)
  WHERE revoked_at IS NULL;

ALTER TABLE automation_authorisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_authorisations FORCE  ROW LEVEL SECURITY;
CREATE POLICY automation_authorisations_tenant ON automation_authorisations
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/*
 * NO UPDATE EXCEPT REVOCATION, ENFORCED RATHER THAN DOCUMENTED. §5 says the
 * bounds are "unchangeable by the automation itself"; this makes them
 * unchangeable by anything, so widening them means authorising again — which
 * is a decision with a name and a date on it.
 */
CREATE OR REPLACE FUNCTION automation_authorisations_immutable() RETURNS trigger AS $$
BEGIN
  IF (OLD.max_rows, OLD.permitted_fields, OLD.permitted_connections,
      OLD.expires_at, OLD.authorised_by, OLD.automation_id)
     IS DISTINCT FROM
     (NEW.max_rows, NEW.permitted_fields, NEW.permitted_connections,
      NEW.expires_at, NEW.authorised_by, NEW.automation_id)
  THEN
    RAISE EXCEPTION 'An authorisation is written once; only its revocation is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER automation_authorisations_immutable
  BEFORE UPDATE ON automation_authorisations
  FOR EACH ROW EXECUTE FUNCTION automation_authorisations_immutable();

GRANT SELECT, INSERT, UPDATE ON automation_authorisations TO silo_app;

/*
 * §10 — "automation.execute is deliberately separate and should be rare. It is
 * the only permission in the product that allows a write with nobody present."
 *
 * NOT SCOPEABLE, AND SUPER ADMIN ONLY. `automation.mutate` is scopeable because
 * a scope admin already approves changes in their own subtree; this one is not
 * delegable at all, because the thing it authorises has no subtree — it is a
 * write with nobody present anywhere.
 *
 * HELD BY THE NARROWEST ROLE RATHER THAN BY NONE. Granting it to nobody was the
 * first attempt, and the permission catalogue test was right to refuse it: a
 * permission no role holds is not rare, it is unreachable, and every route
 * behind it refuses everybody. "Should be rare" is about how often a super
 * admin attaches it, which is a decision the product can make visible — not
 * about making the capability impossible to reach.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('automation.execute', 'automation', 'Let a scheduled check write without a person present', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'automation.execute'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
