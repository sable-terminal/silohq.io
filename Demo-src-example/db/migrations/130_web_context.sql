/*
 * Context from the web — on for every organisation, until a super admin
 * switches it off for everybody in it.
 *
 * The Console's web switch is each person's; this is the organisation's, and
 * it wins. An organisation whose customer list is itself sensitive — a defence
 * supplier's, a law firm's — may not want even company names sent to a search,
 * however little the search keeps. Who switched it off, and when; switching it
 * back on deletes the row, and the audit trail keeps both acts.
 */

CREATE TABLE web_context_opt_outs (
  organisation_id uuid        PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  switched_off_by uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  switched_off_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE web_context_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_context_opt_outs FORCE  ROW LEVEL SECURITY;
CREATE POLICY web_context_opt_outs_tenant ON web_context_opt_outs
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON web_context_opt_outs TO silo_app;
