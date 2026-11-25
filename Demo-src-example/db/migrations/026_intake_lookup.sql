-- 026_intake_lookup — finding a connection by the address something posted to.
--
-- ── Why this is `SECURITY DEFINER` ──────────────────────────────────────────
--
-- A webhook arrives with no session and no organisation. WHICH organisation it
-- belongs to is exactly what the token tells us, so the lookup has to happen
-- before any tenant context exists — and row level security is designed to make
-- that impossible. This is the third deliberate hole in the schema, alongside
-- `invitation_by_token` and `consume_oauth_state`, and it is narrow the same way
-- they are:
--
--   it takes a token HASH and nothing else
--   it returns exactly one row, or none
--   it returns no payload, no credential and no manifest document beyond what
--     is needed to route the event
--   `search_path` is pinned, so a shadowed `connections` cannot be substituted
--
-- The token is unguessable and never stored in clear, so possessing the hash is
-- the whole authorisation — the same standing an invitation token has.

CREATE FUNCTION connection_by_intake_token(token_hash text)
RETURNS TABLE (
  id uuid,
  organisation_id uuid,
  intake_retention_hours integer,
  status text,
  document jsonb,
  schema_version integer
) AS $$
  SELECT c.id, c.organisation_id, c.intake_retention_hours, c.status,
         m.document, m.schema_version
    FROM connections c
    JOIN connector_manifests m ON m.id = c.manifest_id
   WHERE c.intake_token_hash = token_hash
   LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION connection_by_intake_token(text) TO silo_app;

/**
 * Record that an event arrived.
 *
 * SAME REASONING, SAME NARROWNESS. The `UPDATE` that stamps `intake_last_seen_at`
 * runs before a tenant is established too, and it touches one column on one row
 * identified by a hash nobody can produce without the token.
 */
CREATE FUNCTION note_intake_seen(token_hash text) RETURNS void AS $$
  UPDATE connections SET intake_last_seen_at = now() WHERE intake_token_hash = token_hash;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION note_intake_seen(text) TO silo_app;
