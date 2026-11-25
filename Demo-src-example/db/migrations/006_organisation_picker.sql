-- 006_organisation_picker — letting somebody see the names of the organisations
-- they belong to, before they have chosen one.
--
-- THE PICKER COULD ONLY SHOW UUIDS. `memberships_own` lets a person read their
-- own membership rows without a tenant, which is what makes the login picker
-- possible at all — but a membership row carries an `organisation_id` and no
-- name, and `organisations_tenant` requires a tenant that has not been chosen
-- yet. So a user in three organisations was offered three uuids and asked to
-- pick one. The policy was right and the pair of them was incomplete.
--
-- FOUND BY BUILDING THE SCREEN. Nothing about the schema looks wrong until
-- something has to render it.
--
-- `FOR SELECT`, FOR THE SAME REASON `memberships_own` IS. Policies are
-- permissive and OR together, so a policy with no command restriction would
-- also grant INSERT and UPDATE — letting somebody modify any organisation they
-- happen to be a member of, from outside its tenant.
--
-- ACTIVE MEMBERSHIPS ONLY. A removed or suspended member should not keep a
-- window onto the organisation's name, and `invited` is not yet membership.

CREATE POLICY organisations_own ON organisations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
       WHERE m.organisation_id = organisations.id
         AND m.user_id = app_user_id()
         AND m.status = 'active'
    )
  );
