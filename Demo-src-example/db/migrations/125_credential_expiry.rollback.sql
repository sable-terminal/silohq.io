DROP INDEX IF EXISTS credentials_lapsing;
ALTER TABLE connection_credentials
  DROP CONSTRAINT IF EXISTS connection_credentials_expiry_explained,
  DROP COLUMN IF EXISTS expiry_stage,
  DROP COLUMN IF EXISTS expiry_source,
  DROP COLUMN IF EXISTS credential_expires_at,
  DROP COLUMN IF EXISTS sealed_by;
