/*
 * 111 — sharing a saved view.
 *
 * ── THE CEILING WAS BUILT BEFORE THE ACT ──────────────────────────────────
 *
 * AUTH rev 7 describes `view_shares` and the four sharing policies, and the
 * policy has been settable, readable and enforced for maps since 036 — over an
 * act nobody could perform. `view.share` is in three role catalogues,
 * `view_shared`, `view_share_revoked` and `view_opened_with_reduced_permissions`
 * have been in the audit catalogue since it was written, and no code path could
 * emit any of them. This is the table that was missing.
 *
 * ── SHAPED LIKE `map_shares`, DELIBERATELY ────────────────────────────────
 *
 * The same three grantees, the same one-grantee CHECK, the same expiry and
 * revocation columns, the same uniqueness. Two features sharing one shape means
 * one policy check, one mental model, and no argument later about which one is
 * right — and the difference between them is only what access means.
 *
 * ── PRIVATE UNTIL AN OWNER ACTS, AND VISIBILITY IS NOT A COLUMN ───────────
 *
 * rev 7 lists a `visibility` column on `saved_views`. It is not here, because
 * it would be a second statement of what the shares already say, and the two
 * would disagree the first time a share expired: a view is private when nothing
 * live points at it, shared when something does, and organisation-visible when
 * one of those is organisation-wide. Derived, not stored.
 */

CREATE TABLE view_shares (
  id                uuid        PRIMARY KEY,
  organisation_id   uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  view_id           uuid        NOT NULL REFERENCES saved_views(id) ON DELETE CASCADE,

  membership_id     uuid        REFERENCES memberships(id) ON DELETE RESTRICT,
  scope_id          uuid        REFERENCES scopes(id) ON DELETE RESTRICT,
  organisation_wide boolean     NOT NULL DEFAULT false,

  CONSTRAINT view_shares_one_grantee CHECK (
    (membership_id IS NOT NULL)::int + (scope_id IS NOT NULL)::int + (organisation_wide)::int = 1
  ),

  /*
   * rev 7's three: see it, run it, or take a copy.
   *
   * THERE IS NO `edit`, AND THE OMISSION IS THE SAME ONE MAPS MAKE. A view
   * somebody else can edit is a question two people are answering, and the
   * second one has no way to know what the first meant by it. `copy` is how
   * that is done: the copy is theirs, and the two diverge honestly.
   *
   * `view` IS THE WEAKEST AND IT IS NOT NOTHING. A saved view holds no answer,
   * so seeing one is seeing a question — which is worth sharing on its own,
   * and is all somebody without `query.run` could use anyway.
   */
  access            text        NOT NULL CHECK (access IN ('view', 'run', 'copy')),

  shared_by         uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  shared_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,

  /* rev 7 — "re-sharing updates rather than duplicates". */
  CONSTRAINT view_shares_unique_grantee UNIQUE (view_id, membership_id, scope_id, organisation_wide)
);

CREATE INDEX view_shares_by_view ON view_shares (view_id);
CREATE INDEX view_shares_by_membership ON view_shares (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX view_shares_by_scope ON view_shares (scope_id) WHERE scope_id IS NOT NULL;

ALTER TABLE view_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE view_shares FORCE  ROW LEVEL SECURITY;
CREATE POLICY view_shares_tenant ON view_shares
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON view_shares TO silo_app;
