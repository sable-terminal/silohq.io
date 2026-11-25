DROP TRIGGER IF EXISTS manifests_immutable_once_used ON connector_manifests;
DROP TRIGGER IF EXISTS connections_tier_ladder ON connections;
DROP TRIGGER IF EXISTS connections_writes_off_at_birth ON connections;
DROP FUNCTION IF EXISTS connections_promote_one_step();
DROP FUNCTION IF EXISTS connections_writes_start_disabled();
DROP FUNCTION IF EXISTS tier_rank(text);
DROP TABLE IF EXISTS connections;
