/*
 * 081 — simulation allowances.
 *
 * ── A separate pool, on purpose ────────────────────────────────────────────
 *
 * Billing §5: "Separate allowance, never drawn from the token pool. Different
 * cost base, and a shared pool would let a customer buy expensive capability
 * with cheap units." A simulation walks a dependency graph and recomputes
 * against current data; a compile plans a question. Selling one in units of the
 * other is selling the wrong thing.
 *
 * ── Built before the thing it meters ───────────────────────────────────────
 *
 * There is no simulation to run yet: `scenario.util` and `dependencyGraph.util`
 * are arithmetic nobody calls. The pool exists first so that when simulations
 * arrive they cannot quietly come out of the token allowance, which is exactly
 * what would happen if the only pool in the schema were the token one.
 */

CREATE TABLE simulation_allowances (
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  granted         integer     NOT NULL CHECK (granted >= 0),
  consumed        integer     NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  /* Bought separately, priced per simulation, and not expiring with the period. */
  purchased_remaining integer NOT NULL DEFAULT 0 CHECK (purchased_remaining >= 0),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, period_start),
  CONSTRAINT simulation_allowances_period CHECK (period_end > period_start)
);

CREATE INDEX simulation_allowances_current ON simulation_allowances (organisation_id, period_end DESC);

ALTER TABLE simulation_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_allowances FORCE  ROW LEVEL SECURITY;
CREATE POLICY simulation_allowances_tenant ON simulation_allowances
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON simulation_allowances TO silo_app;
