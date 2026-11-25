DROP TRIGGER IF EXISTS discovery_run_authorised ON discovery_runs;
DROP TRIGGER IF EXISTS discovery_auth_needs_enabled ON discovery_authorisations;
DROP FUNCTION IF EXISTS discovery_run_needs_live_authorisation();
DROP FUNCTION IF EXISTS discovery_requires_enabled();
DROP TABLE IF EXISTS discovery_findings;
DROP TABLE IF EXISTS discovery_runs;
DROP TABLE IF EXISTS discovery_authorisations;
DROP TABLE IF EXISTS discovery_settings;
