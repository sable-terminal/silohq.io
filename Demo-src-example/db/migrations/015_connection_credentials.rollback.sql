-- THIS MIGRATION REFUSES TO ROLL BACK.
--
-- Dropping `connection_credentials` destroys sealed material that a KMS key
-- alone cannot reconstruct — the ciphertext and the wrapped data key are here,
-- and the KEK unwraps nothing without them. Every customer would have to
-- reconnect every system.
--
-- Real rollback is a restore from backup, taken deliberately, by somebody who
-- has decided that is what they want. A `DROP TABLE` behind a routine
-- `migrate:down` is that decision made by accident.
--
-- `oauth_pending_states` alone would be safe to drop, and is left in place
-- rather than split out: a partial rollback that leaves half the migration
-- applied is worse than one that refuses cleanly.
DO $$
BEGIN
  RAISE EXCEPTION
    'Refusing to roll back 015: dropping connection_credentials destroys sealed material that cannot be recovered from KMS. Restore from backup instead.'
    USING ERRCODE = 'raise_exception';
END $$;
