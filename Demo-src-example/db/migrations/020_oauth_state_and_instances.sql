-- 020_oauth_state_and_instances — closing two gaps before the OAuth engine.
--
-- Both are cheap now and awkward once the engine exists, because the first
-- writes a rule the engine has to be built around and the second adds a column
-- every connection created before it would lack.

/*
 * ── 1. A state is single use, enforced ──────────────────────────────────────
 *
 * `consumed_at` WAS A COLUMN AND NOTHING CONSUMED IT. Replaying a captured
 * callback is the attack the state parameter exists to defend against, and a
 * column recording that something happened is not a mechanism for stopping it
 * happening twice.
 *
 * THE CHECK AND THE MARK ARE ONE STATEMENT, for the same reason
 * `consume_password_reset` is: a read followed by a write opens a window in
 * which two concurrent callbacks both see an unconsumed row, both proceed, and
 * the second seals a token obtained by whoever replayed the link.
 *
 * `SECURITY DEFINER` BECAUSE THE CALLBACK HAS NO TENANT. It arrives as a browser
 * navigation carrying only a state — discovering which organisation it belongs
 * to is the whole job, so a policy keyed on `app_org_id()` cannot serve the
 * query that establishes it. Narrow by construction: it takes a secret, returns
 * at most one row, and pins its `search_path`.
 */
CREATE OR REPLACE FUNCTION consume_oauth_state(p_state_hash text)
RETURNS TABLE (
  connection_id uuid,
  organisation_id uuid,
  initiated_by uuid,
  code_verifier text,
  requested_scopes text[]
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE oauth_pending_states SET consumed_at = now()
   WHERE state_hash = p_state_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING connection_id, organisation_id, initiated_by, code_verifier, requested_scopes;
$$;

/*
 * §4.3: pending connections expire and are swept. A provider returning an error
 * rather than a code, and a user closing the tab, both leave a row behind.
 *
 * A FUNCTION RATHER THAN A DELETE THE CRON WRITES, because a sweeper runs for
 * nobody — `app_org_id()` is null, the tenant policy matches nothing, and the
 * delete silently removes zero rows while reporting success.
 *
 * IT ONLY REMOVES WHAT IS ALREADY DEAD. A sweep that could delete a live flow
 * would be a way to cancel somebody's sign-in from outside it.
 */
CREATE OR REPLACE FUNCTION sweep_oauth_states(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM oauth_pending_states
   WHERE expires_at < p_before OR (consumed_at IS NOT NULL AND consumed_at < p_before);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

GRANT EXECUTE ON FUNCTION consume_oauth_state(text)          TO silo_app;
GRANT EXECUTE ON FUNCTION sweep_oauth_states(timestamptz)    TO silo_app;

/*
 * ── 2. Which instance a connection actually reached ─────────────────────────
 *
 * RESOLVED AFTER THE TOKEN EXCHANGE, NOT ASKED FOR. The provider tells us: a
 * Salesforce instance URL, a Xero tenant id, a Workspace domain. Until then it
 * is unknown, which is why the column is nullable rather than defaulted to
 * something that looks like an answer.
 *
 * NOT UNIQUE, DELIBERATELY. Two people in one organisation connecting the same
 * Salesforce org is probably a duplicate and possibly intentional — a second
 * connection with different scopes, or one being replaced before the old is
 * revoked. A constraint would turn a question worth asking into an error at the
 * end of an OAuth flow the person has already completed, with nothing to do
 * about it but start again.
 *
 * SCOPED WITHIN AN ORGANISATION. Two different tenants connecting the same
 * Salesforce instance are two customers of that instance, which is nobody's
 * business but theirs, and comparing across tenants would be a cross-tenant read
 * wearing a duplicate check.
 */
ALTER TABLE connections
  ADD COLUMN source_instance_id text
    CHECK (source_instance_id IS NULL OR length(trim(source_instance_id)) BETWEEN 1 AND 256),
  /** What to call it in "you already have this connected". */
  ADD COLUMN source_instance_label text
    CHECK (source_instance_label IS NULL OR length(trim(source_instance_label)) BETWEEN 1 AND 256),
  ADD COLUMN source_resolved_at timestamptz,

  ADD CONSTRAINT connections_instance_dated CHECK (
    (source_instance_id IS NULL) = (source_resolved_at IS NULL)
  );

CREATE INDEX connections_by_instance
  ON connections (organisation_id, source_instance_id)
  WHERE source_instance_id IS NOT NULL AND status <> 'revoked';
