-- 043_grant_hygiene — the grantee nobody indexed, and the functions anybody can call.
--
-- ── An organisation-wide grant could be granted twice ──────────────────────
--
-- 016 gave `connection_grants` three grantees and a partial unique index for
-- each: one live grant per connection per membership, per scope, per principal.
-- 028 added a FOURTH — `organisation_wide` — and no index with it.
--
-- So a connection can carry two live organisation-wide grants. That is not a
-- tidiness problem: `revokeGrant` sets `revoked_at` on one row, the second stays
-- live, and `readableIds` still returns the connection for everybody. Somebody
-- revokes access, is told it worked, and access continues — which is the worst
-- shape a permission bug can take, because nothing looks wrong afterwards.
--
-- ── SECURITY DEFINER, executable by anyone ─────────────────────────────────
--
-- Seventeen functions run as their definer, which is how they reach past row
-- level security to do the one thing they exist for — find a user by email
-- before there is a session, consume a single-use token, sweep expired rows.
-- Every one of them was executable by PUBLIC.
--
-- 002 got this right for its two and nothing since has: `invitation_by_token`
-- and `claim_invitation` are revoked from PUBLIC and granted to `silo_app`
-- explicitly. The rest were left open, so any role that can connect to this
-- database can call `user_by_email` or `session_by_token` and read rows RLS
-- exists to keep from it.
--
-- Today only `silo_app` connects, so the practical exposure is small. It is
-- worth closing anyway: the next role added — a reporting user, an analyst, a
-- migration runner someone points at production — inherits PUBLIC, and inherits
-- it silently.

/*
 * The fourth grantee, indexed like the other three. `organisation_wide` is a
 * boolean rather than a nullable id, so the predicate is the flag itself.
 */
CREATE UNIQUE INDEX connection_grants_one_per_organisation
  ON connection_grants (connection_id)
  WHERE organisation_wide AND revoked_at IS NULL;

REVOKE ALL ON FUNCTION api_key_by_token(p_token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION connection_by_intake_token(token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_oauth_state(p_state_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_password_reset(p_token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_sso_attempt(p_state text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_sso_attempt(p_state text, p_provider_id uuid, p_nonce text, p_code_verifier text, p_return_to text, p_expires_at timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_expired_sessions(p_before timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_provider_by_id(p_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity_provider_for_domain(p_domain text) FROM PUBLIC;
REVOKE ALL ON FUNCTION link_federated_identity(p_id uuid, p_user_id uuid, p_provider_id uuid, p_subject text, p_email text) FROM PUBLIC;
REVOKE ALL ON FUNCTION note_intake_seen(token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION session_by_token(p_token_hash text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sweep_inbound_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION sweep_oauth_states(p_before timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_api_key(p_key_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION user_by_email(p_email text) FROM PUBLIC;
REVOKE ALL ON FUNCTION user_for_federated_subject(p_provider_id uuid, p_subject text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION api_key_by_token(p_token_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION connection_by_intake_token(token_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION consume_oauth_state(p_state_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION consume_password_reset(p_token_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION consume_sso_attempt(p_state text) TO silo_app;
GRANT EXECUTE ON FUNCTION create_sso_attempt(p_state text, p_provider_id uuid, p_nonce text, p_code_verifier text, p_return_to text, p_expires_at timestamp with time zone) TO silo_app;
GRANT EXECUTE ON FUNCTION delete_expired_sessions(p_before timestamp with time zone) TO silo_app;
GRANT EXECUTE ON FUNCTION identity_provider_by_id(p_id uuid) TO silo_app;
GRANT EXECUTE ON FUNCTION identity_provider_for_domain(p_domain text) TO silo_app;
GRANT EXECUTE ON FUNCTION link_federated_identity(p_id uuid, p_user_id uuid, p_provider_id uuid, p_subject text, p_email text) TO silo_app;
GRANT EXECUTE ON FUNCTION note_intake_seen(token_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION session_by_token(p_token_hash text) TO silo_app;
GRANT EXECUTE ON FUNCTION sweep_inbound_events() TO silo_app;
GRANT EXECUTE ON FUNCTION sweep_oauth_states(p_before timestamp with time zone) TO silo_app;
GRANT EXECUTE ON FUNCTION touch_api_key(p_key_id uuid) TO silo_app;
GRANT EXECUTE ON FUNCTION user_by_email(p_email text) TO silo_app;
GRANT EXECUTE ON FUNCTION user_for_federated_subject(p_provider_id uuid, p_subject text) TO silo_app;
