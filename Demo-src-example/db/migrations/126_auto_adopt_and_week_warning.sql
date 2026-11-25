/*
 * 126 — two operating details of MANIFEST-V2 §3.7.
 *
 * `auto_adopt_prebuilt`: an organisation may let its connections to Silo's own
 * prebuilt connectors move to a new version by themselves, weekly — only when
 * nothing about where a credential goes or what runs has changed, and only
 * after every object has been read with the new version. Off unless switched
 * on; tenant-authored connectors never move by themselves.
 *
 * `expiry_stage` gains `week`: a lapsing credential is warned about at
 * fourteen, seven and one day, and on the day.
 */
ALTER TABLE organisations ADD COLUMN auto_adopt_prebuilt boolean NOT NULL DEFAULT false;

ALTER TABLE connection_credentials DROP CONSTRAINT IF EXISTS connection_credentials_expiry_stage_check;
ALTER TABLE connection_credentials
  ADD CONSTRAINT connection_credentials_expiry_stage_check CHECK (expiry_stage IN ('upcoming', 'week', 'imminent', 'expired'));
