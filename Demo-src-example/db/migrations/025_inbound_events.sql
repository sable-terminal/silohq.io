-- 025_inbound_events — what arrived, held briefly and never permanently.
--
-- ── Why this table is allowed to exist at all ───────────────────────────────
--
-- Silo's claim is that it stores no customer data PERMANENTLY. The two inbound
-- transports have no other shape: a webhook and a forwarded email push their
-- payload at us, and "query this connector" can only mean "read what arrived".
-- Nothing can be fetched back from a webhook.
--
-- SO THE RETENTION IS THE DESIGN, AND IT IS ENFORCED RATHER THAN INTENDED.
-- `expires_at` is NOT NULL and a CHECK caps it at the ceiling below, so a row
-- that outlives its window cannot be written — not by this service, not by a
-- migration, not by somebody with a psql prompt and a good reason. "We sweep it
-- later" is a promise; a constraint is not.
--
-- READS FILTER ON `expires_at` TOO. A sweep that has not run yet must not
-- silently extend retention, so an expired row is invisible from the moment it
-- expires and the sweep is only reclaiming space.

CREATE TABLE inbound_events (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  connection_id   uuid        NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,

  /** Which object in the manifest this payload is an instance of. */
  object_name     text        NOT NULL CHECK (length(trim(object_name)) BETWEEN 1 AND 128),

  /*
   * THE CUSTOMER'S OWN DATA, WHICH IS THE POINT AND THE PROBLEM. It is here
   * because there is nowhere else for it to be, and it is here briefly.
   */
  payload         jsonb       NOT NULL,

  /*
   * WHAT THE SENDER CALLED ITSELF. Not trusted for anything — it is written by
   * whoever posted — but a person looking at a queue of events needs to see it.
   */
  source_label    text,

  received_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,

  CONSTRAINT inbound_events_bounded CHECK (
    expires_at > received_at
    AND expires_at <= received_at + interval '30 days'
  )
);

CREATE INDEX inbound_events_readable
  ON inbound_events (connection_id, object_name, received_at DESC);

CREATE INDEX inbound_events_expiring ON inbound_events (expires_at);

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY inbound_events_tenant ON inbound_events
  USING (organisation_id = app_org_id())
  WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, DELETE ON inbound_events TO silo_app;

/*
 * NO UPDATE GRANT. An event is what arrived; editing one would make the record
 * of what a customer's system sent into something Silo can rewrite, and the
 * expiry is the field somebody would be tempted to move.
 */

-- ── Where events arrive ─────────────────────────────────────────────────────
--
-- THE ADDRESS IS THE CREDENTIAL, for both inbound transports. A webhook URL and
-- a minted email address are both unauthenticated endpoints that anybody who
-- knows them can post to, so the token is random and stored only as a hash —
-- the same treatment as a session token, for the same reason.

ALTER TABLE connections
  ADD COLUMN intake_token_hash text,
  ADD COLUMN intake_last_seen_at timestamptz,
  /*
   * HOW LONG THIS CONNECTION KEEPS WHAT IT RECEIVES. Per connection because a
   * webhook feeding a daily figure needs a day and one feeding a quarterly
   * reconciliation needs longer; capped here as well as in the CHECK above so
   * the ceiling holds even if a later default is set carelessly.
   */
  ADD COLUMN intake_retention_hours integer NOT NULL DEFAULT 168
    CHECK (intake_retention_hours BETWEEN 1 AND 720);

CREATE UNIQUE INDEX connections_intake_token
  ON connections (intake_token_hash) WHERE intake_token_hash IS NOT NULL;

/**
 * Reclaim expired events.
 *
 * `SECURITY DEFINER` BECAUSE IT RUNS WITHOUT A TENANT. A sweep belongs to no
 * organisation and must reach every one of them, which row level security is
 * precisely designed to prevent — so this is a deliberate, narrow hole: it takes
 * no arguments, reads nothing, and can only delete rows that have already
 * expired. `search_path` is pinned so a shadowed table cannot be substituted.
 */
CREATE FUNCTION sweep_inbound_events() RETURNS integer AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM inbound_events WHERE expires_at <= now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION sweep_inbound_events() TO silo_app;
