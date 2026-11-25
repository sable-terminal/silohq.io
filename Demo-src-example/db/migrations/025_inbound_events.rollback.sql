DROP FUNCTION IF EXISTS sweep_inbound_events();
DROP INDEX IF EXISTS connections_intake_token;
ALTER TABLE connections
  DROP COLUMN IF EXISTS intake_token_hash,
  DROP COLUMN IF EXISTS intake_last_seen_at,
  DROP COLUMN IF EXISTS intake_retention_hours;
DROP TABLE IF EXISTS inbound_events;
