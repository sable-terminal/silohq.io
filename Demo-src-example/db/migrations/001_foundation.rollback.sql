-- Undo 001_foundation.
--
-- The extensions are left in place. They are cluster furniture rather than this
-- migration's property, another schema in the same database may be using them,
-- and dropping `citext` takes every column typed with it.
--
-- The roles are left in place too, for the same reason and a stronger one: they
-- are cluster-level, created outside the ledger by `db:roles`, and dropping a
-- role that owns objects in another database fails in a way that is confusing to
-- diagnose from here.

DROP POLICY IF EXISTS memberships_tenant ON memberships;
DROP POLICY IF EXISTS organisations_tenant ON organisations;

DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organisations;

DROP FUNCTION IF EXISTS app_membership_id();
DROP FUNCTION IF EXISTS app_org_id();
