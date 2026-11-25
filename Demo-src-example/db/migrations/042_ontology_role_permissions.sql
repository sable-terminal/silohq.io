-- 042_ontology_role_permissions — giving the ontology permissions to somebody.
--
-- 031, 033 and 040 each added a row to `permissions` and stopped there. A
-- permission in the catalogue that belongs to no role is held by nobody, so
-- `assertCan` refuses everybody — and the routes behind `concept.confirm`,
-- `marking.apply` and `outcome.designate` were a permanent 403 for every user
-- in every organisation, including the one that created it.
--
-- ── Two halves, and the second is the one that gets forgotten ──────────────
--
-- `SYSTEM_ROLES` in `models/authz.model.ts` is what a NEW organisation is seeded
-- with; adding a permission there fixes tomorrow's tenants. Every organisation
-- that already exists has its roles as rows, and nothing re-reads that list — so
-- they need this backfill, and 024 has the same gap for `discovery.manage`
-- against any organisation created before it landed.
--
-- ── Who gets what ──────────────────────────────────────────────────────────
--
-- `concept.confirm` goes to both admin tiers because it is `scopeable`: the
-- blast radius is bounded by the connections the admin can already reach.
--
-- The other two go to super admins only, matching their `scopeable = false`.
-- Deciding what is secret and deciding what counts as a bad outcome are
-- statements about the whole business, and every ranking anybody sees afterwards
-- is ordered by the second.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, g.permission_id
  FROM roles r
  JOIN (VALUES
          ('Super admin', 'concept.confirm'),
          ('Super admin', 'marking.apply'),
          ('Super admin', 'outcome.designate'),
          ('Admin',       'concept.confirm')
       ) AS g(role_name, permission_id)
    ON g.role_name = r.name
 WHERE r.system_role
ON CONFLICT DO NOTHING;

/* 024 never backfilled either, for organisations that predate it. */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'discovery.manage'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
