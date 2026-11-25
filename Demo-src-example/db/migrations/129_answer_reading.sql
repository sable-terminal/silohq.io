/*
 * Answers written up by a model — on for every organisation, until a super
 * admin switches it off.
 *
 * The Console used to describe an answer in fixed sentences made from its
 * figures, and the model only ever saw names. Writing about what an answer
 * found — in depth, with a chart chosen to fit it and follow-up questions
 * answered — needs the model to read what the answer read. It is the product's
 * default; an organisation that does not want it says so here: who switched
 * it off, and when. Switching it back on deletes the row, and the audit trail
 * keeps both acts.
 *
 * Nothing is sent, whatever this table says, until the deployment has
 * confirmed zero retention with the model provider.
 */

CREATE TABLE answer_reading_opt_outs (
  organisation_id uuid        PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  switched_off_by uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  switched_off_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE answer_reading_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_reading_opt_outs FORCE  ROW LEVEL SECURITY;
CREATE POLICY answer_reading_opt_outs_tenant ON answer_reading_opt_outs
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON answer_reading_opt_outs TO silo_app;
