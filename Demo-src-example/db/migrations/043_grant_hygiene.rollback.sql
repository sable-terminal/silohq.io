DROP INDEX IF EXISTS connection_grants_one_per_organisation;

GRANT EXECUTE ON FUNCTION api_key_by_token(p_token_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION connection_by_intake_token(token_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION consume_oauth_state(p_state_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION consume_password_reset(p_token_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION consume_sso_attempt(p_state text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION create_sso_attempt(p_state text, p_provider_id uuid, p_nonce text, p_code_verifier text, p_return_to text, p_expires_at timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION delete_expired_sessions(p_before timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION identity_provider_by_id(p_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION identity_provider_for_domain(p_domain text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION link_federated_identity(p_id uuid, p_user_id uuid, p_provider_id uuid, p_subject text, p_email text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION note_intake_seen(token_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION session_by_token(p_token_hash text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_inbound_events() TO PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_oauth_states(p_before timestamp with time zone) TO PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_key(p_key_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION user_by_email(p_email text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION user_for_federated_subject(p_provider_id uuid, p_subject text) TO PUBLIC;
