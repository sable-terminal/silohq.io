UPDATE connection_credentials SET expiry_stage = 'upcoming' WHERE expiry_stage = 'week';
ALTER TABLE connection_credentials DROP CONSTRAINT IF EXISTS connection_credentials_expiry_stage_check;
ALTER TABLE connection_credentials
  ADD CONSTRAINT connection_credentials_expiry_stage_check CHECK (expiry_stage IN ('upcoming', 'imminent', 'expired'));
ALTER TABLE organisations DROP COLUMN IF EXISTS auto_adopt_prebuilt;
