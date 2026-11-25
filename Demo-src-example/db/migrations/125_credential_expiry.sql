/*
 * 125 — when a credential itself stops working, and who to tell.
 *
 * `expires_at` HAS ALWAYS BEEN THE ACCESS TOKEN'S: an hour, refreshed without
 * anybody noticing. What this adds is the other kind of expiry — the client
 * certificate that lapses on its notAfter, the personal access token a system
 * issues for ninety days, the signed token with an `exp` — which nothing can
 * refresh and which, unwarned, is a connection that works on Friday and fails
 * on Monday with an authentication error nobody connects to a date.
 *
 * `expiry_source` SAYS HOW IT IS KNOWN, because a date read off a certificate
 * and a date a connector declared are not equally certain. `expiry_stage` is
 * the last warning sent, so a sweep that runs every day tells people once per
 * stage and not every morning.
 *
 * `sealed_by` IS WHO GAVE IT: the person best placed to replace it.
 */
ALTER TABLE connection_credentials
  ADD COLUMN sealed_by uuid REFERENCES memberships(id) ON DELETE RESTRICT,
  ADD COLUMN credential_expires_at timestamptz,
  ADD COLUMN expiry_source text CHECK (expiry_source IN ('certificate', 'token', 'declared')),
  ADD COLUMN expiry_stage text CHECK (expiry_stage IN ('upcoming', 'imminent', 'expired')),
  ADD CONSTRAINT connection_credentials_expiry_explained CHECK ((credential_expires_at IS NULL) = (expiry_source IS NULL));

CREATE INDEX credentials_lapsing ON connection_credentials (credential_expires_at)
  WHERE credential_expires_at IS NOT NULL;
