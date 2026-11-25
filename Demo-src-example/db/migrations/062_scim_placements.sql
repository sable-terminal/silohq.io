/*
 * §1 — which scope placements the directory made, so it can only take back its
 * own.
 *
 * The role half of a group mapping was already bounded by `granted_by`: a grant
 * a human made for their own reasons is not the directory's to take away. The
 * SCOPE half had no such bound and deleted the row whoever created it — so a
 * directory could strip somebody a person had placed by hand, including the
 * founder, who normally exists in the directory too.
 *
 * PLACEMENT IS NOT COSMETIC. `effectivePermissions#reaches` makes a connection
 * grant or a scoped role bite only where the subject SITS at or beneath the
 * scope it was made at, and that comes from `scope_memberships`. Removing a
 * placement silently removes every connection reachable through it.
 */
ALTER TABLE scope_memberships
  ADD COLUMN added_by_scim boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scope_memberships.added_by_scim IS
  'True where a directory group mapping created this placement. A placement a person made is not the directory''s to remove.';
