-- 023_finding_method — how a thing was found, recorded on the finding.
--
-- §9.3 REQUIRES THE PROBE LOG TO NAME THE METHOD: "what was contacted, when, by
-- which agent, under which authorisation". The authorisation carries the methods
-- it PERMITS; without this column nothing carries the method actually USED, so a
-- review could see that a scan was allowed to introspect catalogues and port
-- scan, and not which of the two reached a given host.
--
-- IT ALSO CHANGES HOW MUCH A FINDING IS WORTH. "Postgres, from the catalogue"
-- is a schema; "Postgres, from a port scan" is a guess from an open 5432. An
-- admin approving findings one by one needs to know which they are looking at.

ALTER TABLE discovery_findings
  ADD COLUMN method text NOT NULL DEFAULT 'port_scan'
    CHECK (method IN ('port_scan', 'read_host_config', 'catalogue_introspect'));

-- The default exists only to add the column to rows that predate it. A finding
-- recorded from now on states its method, and there are no such rows yet.
ALTER TABLE discovery_findings ALTER COLUMN method DROP DEFAULT;
