-- 064_silo_role_permissions — who may turn on storage, and who may not.
--
-- ── The defect this corrects ───────────────────────────────────────────────
--
-- `silo.enable` was seeded in 004 as `scopeable = true` and granted to `Admin`.
-- §10 is explicit and it is the opposite: SUPER ADMIN ONLY, NOT DELEGABLE TO A
-- SCOPE ADMIN. A scope administrator administers part of a network, and
-- deciding that the organisation now stores customer data is not a statement
-- about part of a network — it changes what the company holds, what it must
-- disclose, and what a subject access request has to answer.
--
-- Scopeable was also load-bearing in the wrong direction: a `scopeable`
-- permission can be granted WITHIN a scope by anybody who can grant in that
-- scope, so the switch was reachable one delegation below where it belonged.
--
-- ── And its description was describing three permissions ───────────────────
--
-- "Create a Silo and choose what it stores" is `silo.create` and `silo.manage`,
-- which 063 splits out. `silo.enable` is the master switch and nothing else:
-- with it off, none of the other three can do anything at all.
--
-- ── Two halves, and the second is the one that gets forgotten ──────────────
--
-- `SYSTEM_ROLES` in `models/authz.model.ts` seeds NEW organisations. Every
-- organisation that already exists holds its roles as rows and nothing re-reads
-- that list, so the revoke and the grant both have to happen here.

UPDATE permissions
   SET scopeable  = false,
       description = 'Turn on storage for the organisation. The master switch.'
 WHERE id = 'silo.enable';

/*
 * REVOKED FROM ADMIN, EVERYWHERE. This is a narrowing, so it can be run against
 * an organisation that has already been using it — the switch simply stops
 * being reachable from the Admin role, which is where §10 says it never was.
 */
DELETE FROM role_permissions
 WHERE permission_id = 'silo.enable'
   AND role_id IN (SELECT id FROM roles WHERE system_role AND name <> 'Super admin');

/*
 * THE THREE FROM 063, WHICH 063 CATALOGUED AND GRANTED TO NOBODY — the same
 * gap 042 had to repair for the ontology permissions. A permission no role
 * holds makes every route behind it a permanent 403.
 *
 * ALL THREE TO SUPER ADMIN, matching `scopeable = false`. `silo.purge` in
 * particular is separate from `silo.manage` because shortening a retention
 * window is a deletion with a delay on it: a Silo whose window can be set to a
 * day by whoever manages it has no purge permission in any meaningful sense.
 */
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, g.permission_id
  FROM roles r
  JOIN (VALUES
          ('silo.create'),
          ('silo.manage'),
          ('silo.purge')
       ) AS g(permission_id)
    ON true
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
