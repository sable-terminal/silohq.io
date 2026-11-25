DROP INDEX IF EXISTS credentials_by_purpose;
ALTER TABLE connection_credentials
  DROP CONSTRAINT IF EXISTS connection_credentials_client_has_no_refresh,
  DROP CONSTRAINT IF EXISTS connection_credentials_one_per_purpose;
DELETE FROM connection_credentials WHERE purpose = 'client';
ALTER TABLE connection_credentials
  ADD CONSTRAINT connection_credentials_connection_id_auth_strategy_key
  UNIQUE (connection_id, auth_strategy);
ALTER TABLE connection_credentials DROP COLUMN IF EXISTS purpose;
