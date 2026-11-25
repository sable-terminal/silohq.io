-- 024_discovery_permission — `discovery.manage`.
--
-- `scopeable = false` IS THE WHOLE POINT OF THIS ROW. §9.1 — not delegable to a
-- scope admin, on the same reasoning as clearance: a subordinate admin
-- administers part of a network, and a permission that could be granted against
-- their subtree would let them authorise scanning of the parts they do not
-- administer. Making it organisation-wide only is what stops that, rather than a
-- check inside a service that a later caller could route around.

INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('discovery.manage', 'org', 'Turn on agent discovery and authorise scans', false);
