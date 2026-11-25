-- 021_credential_purpose — a client secret and a token are not the same secret.
--
-- ONE ROW PER STRATEGY WAS NOT ENOUGH FOR BRING-YOUR-OWN-CLIENT. §4.4.3 has the
-- customer register an application in their own provider account and hand back a
-- client id and secret, so an OAuth connection holds four values with two very
-- different lifetimes:
--
--   client id and secret   long-lived, changes almost never
--   access and refresh     short-lived, and the refresh token ROTATES on every
--                          use for the providers that do that
--
-- Sealed together, every hourly token refresh would unwrap and re-seal the
-- client secret alongside it — a long-lived credential going through an
-- unwrap/reseal cycle for no reason, and an audit trail where
-- `credential_unwrapped` cannot distinguish "we used the client secret" from
-- "we refreshed a token". Those are the two questions a reviewer asks.

ALTER TABLE connection_credentials
  ADD COLUMN purpose text NOT NULL DEFAULT 'token'
    CHECK (purpose IN ('client', 'token'));

/*
 * The default exists to fill the existing rows and is dropped immediately.
 * Leaving it would let a future insert forget which kind of secret it is
 * holding and be silently treated as a token — which is the row that gets
 * rotated.
 */
ALTER TABLE connection_credentials ALTER COLUMN purpose DROP DEFAULT;

ALTER TABLE connection_credentials
  DROP CONSTRAINT connection_credentials_connection_id_auth_strategy_key;

/*
 * One of each per strategy. A second token row would make "which one did the
 * request use" unanswerable; a second client row would make "which application
 * is this acting as" unanswerable, which is worse.
 */
ALTER TABLE connection_credentials
  ADD CONSTRAINT connection_credentials_one_per_purpose
  UNIQUE (connection_id, auth_strategy, purpose);

/*
 * ROTATION COUNTERS BELONG TO THE TOKEN, NOT THE CLIENT. A client secret does
 * not expire on a schedule and is never refreshed, so a row carrying a refresh
 * failure count for one is describing something that cannot happen.
 */
ALTER TABLE connection_credentials
  ADD CONSTRAINT connection_credentials_client_has_no_refresh CHECK (
    purpose = 'token' OR (refreshed_at IS NULL AND refresh_failure_count = 0)
  );

CREATE INDEX credentials_by_purpose ON connection_credentials (connection_id, purpose);
