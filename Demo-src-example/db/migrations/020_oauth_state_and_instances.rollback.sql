DROP INDEX IF EXISTS connections_by_instance;
ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_instance_dated,
  DROP COLUMN IF EXISTS source_resolved_at,
  DROP COLUMN IF EXISTS source_instance_label,
  DROP COLUMN IF EXISTS source_instance_id;
DROP FUNCTION IF EXISTS sweep_oauth_states(timestamptz);
DROP FUNCTION IF EXISTS consume_oauth_state(text);
