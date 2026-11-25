DROP TABLE IF EXISTS silo_source_credentials;

DROP INDEX IF EXISTS silo_sources_watched_due;
ALTER TABLE silo_sources DROP CONSTRAINT IF EXISTS silo_sources_watch_shape;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS poll_failure_code;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS last_polled_at;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS watch_cursor_names;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS watch_cursor;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS host_fingerprint;
ALTER TABLE silo_sources DROP COLUMN IF EXISTS watch_pattern;
