-- 017_probe_runs — every stage of verification, on every route.
--
-- NOT AI-ROUTE BOOKKEEPING. §7 is identical on all three routes and no route
-- skips it, so a prebuilt connector probes too. "A prebuilt connector was
-- verified when built. A generated one is verified now."

CREATE TABLE probe_runs (
  id            uuid        PRIMARY KEY,
  connection_id uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  stage         text        NOT NULL CHECK (
                  stage IN ('parse', 'probe', 'reconcile', 'propose_mapping', 'confirm', 'verify')),
  status        text        NOT NULL CHECK (status IN ('running', 'passed', 'failed')),

  /*
   * FINDINGS AND ERRORS KEPT APART. "Failure is honest": the builder stops and
   * names the stage that failed rather than emitting a manifest it could not
   * execute, and a single blob mixing what was found with what went wrong makes
   * that message something to reconstruct rather than read.
   */
  findings      jsonb       NOT NULL DEFAULT '{}',
  errors        jsonb       NOT NULL DEFAULT '[]',

  /*
   * READ-ONLY IS A PROPERTY OF THE RUN, RECORDED. §7 step 1 is a read-only
   * sandbox probe; step 4 is the write-verify-undo cycle. The same table serves
   * both and the difference has to be visible afterwards.
   */
  read_only     boolean     NOT NULL DEFAULT true,

  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,

  CONSTRAINT probe_finished CHECK (status = 'running' OR completed_at IS NOT NULL)
);

CREATE INDEX probe_runs_by_connection ON probe_runs (connection_id, started_at DESC);

ALTER TABLE probe_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY probe_runs_tenant ON probe_runs
  USING (EXISTS (SELECT 1 FROM connections c
                  WHERE c.id = connection_id AND c.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM connections c
                       WHERE c.id = connection_id AND c.organisation_id = app_org_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON probe_runs TO silo_app;
