-- 045_map_share_grantees — one live share per grantee, actually enforced.
--
-- ── NULLs are distinct in a unique constraint ──────────────────────────────
--
-- 036 wrote `UNIQUE (map_id, membership_id, scope_id, organisation_wide)` and an
-- upsert targeting it. Two of those three grantee columns are NULL on every row
-- — a share is a person, a scope, or everybody — and in Postgres two NULLs are
-- not equal, so no two rows ever conflict and the constraint matches nothing.
--
-- The `DO UPDATE` therefore never fired. Sharing a map with the same colleague
-- twice INSERTED A SECOND ROW, and then revoking marked one of them and left the
-- other live: the recipient keeps access, the owner is told it was revoked, and
-- nothing looks wrong afterwards. That is the same shape as the organisation-wide
-- connection grant 043 fixed, and it is the worst shape a permission bug takes.
--
-- ── Partial indexes per grantee, like `connection_grants` ──────────────────
--
-- 016 solved this correctly for connection grants: one partial unique index per
-- grantee type, each predicated on that column being present AND the row being
-- live. A revoked share is history and must not block a new one.

ALTER TABLE map_shares DROP CONSTRAINT map_shares_unique_grantee;

CREATE UNIQUE INDEX map_shares_one_per_member
  ON map_shares (map_id, membership_id)
  WHERE membership_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX map_shares_one_per_scope
  ON map_shares (map_id, scope_id)
  WHERE scope_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX map_shares_one_per_organisation
  ON map_shares (map_id)
  WHERE organisation_wide AND revoked_at IS NULL;
