/*
 * 076 — reverting a change: a new change, linked to the receipt it undoes.
 *
 * ── Three-way, at the time of asking ───────────────────────────────────────
 *
 * Mutations §13: "Not an inverse plan computed at write time." What a revert
 * writes is decided when somebody asks for it, by reading every affected record
 * now and comparing it with what the change left (the receipt's verifications)
 * and what was there before (its prior state). A record nobody has touched since
 * reverts cleanly; one somebody has is a conflict, decided field by field.
 *
 * ── A revert is a mutation ─────────────────────────────────────────────────
 *
 * It is a row in `mutations` like any other — same gate, same chain, same run,
 * its own receipt — so it is revertable in turn. This table is only the link,
 * and what was found and decided at the moment of asking.
 *
 * ── No time window ─────────────────────────────────────────────────────────
 *
 * Staleness is detected rather than assumed. The only limits are the original
 * receipt's retention and the account being cancelled.
 */

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('mutation.revert', 'mutation', 'Ask for a change to be reverted', true);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'mutation.revert'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin', 'Member')
ON CONFLICT DO NOTHING;

/*
 * `conflicts` HOLDS VALUES — what each conflicting field held before, after the
 * change, and now — so it lives and dies with the revert mutation, whose own
 * retention bounds it.
 *
 * `reverted_mutation_id` IS NOT A FOREIGN KEY. The change being reverted is
 * deleted when its receipt's retention ends; the revert, with its own receipt,
 * outlives it and still says what it undid. `receipt_id` goes to null then.
 */
CREATE TABLE mutation_reverts (
  mutation_id          uuid        PRIMARY KEY REFERENCES mutations(id) ON DELETE CASCADE,
  organisation_id      uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  reverted_mutation_id uuid        NOT NULL,
  receipt_id           uuid        REFERENCES mutation_receipts(id) ON DELETE SET NULL,
  conflicts            jsonb       NOT NULL CHECK (jsonb_typeof(conflicts) = 'array'),
  resolutions          jsonb       NOT NULL CHECK (jsonb_typeof(resolutions) = 'array'),
  requested_by         uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  requested_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mutation_reverts_of ON mutation_reverts (organisation_id, reverted_mutation_id);

ALTER TABLE mutation_reverts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mutation_reverts FORCE  ROW LEVEL SECURITY;
CREATE POLICY mutation_reverts_tenant ON mutation_reverts
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON mutation_reverts TO silo_app;
