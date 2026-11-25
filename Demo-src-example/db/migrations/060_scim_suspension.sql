/*
 * §1 — who suspended somebody, so a directory cannot undo a person's decision.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * A repeat create reactivated any suspended membership, and a provider re-sends
 * constantly. So an administrator suspending somebody PENDING AN INVESTIGATION
 * — who has not left the company, and is therefore still active in the
 * directory — had that suspension lifted by the next sync. Minutes later, with
 * nobody told.
 *
 * The two suspensions are different acts wearing one status. One says "this
 * person has left"; the other says "this person's access is stopped while we
 * look into something", and only the first is the directory's to reverse.
 *
 * SET ONLY BY SCIM, READ ONLY BY SCIM. `member.service.suspend` leaves it false,
 * which is what makes a human suspension opaque to the provider.
 */
ALTER TABLE memberships
  ADD COLUMN suspended_by_scim boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN memberships.suspended_by_scim IS
  'True where the directory deactivated this membership. A suspension a person made is not the directory''s to lift.';
