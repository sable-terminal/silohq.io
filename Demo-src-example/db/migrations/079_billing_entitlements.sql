/*
 * 079 — subscriptions and entitlements.
 *
 * ── The only part of billing the product reads ─────────────────────────────
 *
 * Billing §2: "Entitlements are the only thing both paths share, and the only
 * part of billing the product reads." Seat assignment, allowances, daily limits,
 * metering and the degradation ladder read this table. Nothing reads Stripe, and
 * nothing branches on whether a customer is self-serve or on a contract — that
 * difference is `source`, and it is recorded rather than acted on.
 *
 * ── Why entitlements are a history, not a settings row ─────────────────────
 *
 * A period's allowances are granted from what was entitled at the time, and a
 * plan change mid-period must not rewrite what last month's grant was made
 * under. So each version is a row with a window, one current at a time, and the
 * old one is closed rather than overwritten.
 *
 * ── Seats are billed from purchase, not from assignment ────────────────────
 *
 * §3. `seat_count` is what is billed; the `seats` table (008) is the pool those
 * licences are held in. An empty seat costs the same as a full one.
 * `seat_count_next` is the lower count a mid-period release takes effect at:
 * the reduction lands on the period boundary, and nothing is refunded before it.
 */

CREATE TABLE subscriptions (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  plan                 text        NOT NULL CHECK (plan IN ('standard', 'business', 'enterprise')),
  seat_count           integer     NOT NULL CHECK (seat_count >= 1),
  /* Null unless a release is waiting for the boundary. Never above `seat_count`. */
  seat_count_next      integer     CHECK (seat_count_next >= 1),
  term                 text        NOT NULL CHECK (term IN ('monthly', 'annual')),
  /* The ladder's percentage as applied, kept because the ladder can move. */
  discount_percent     integer     NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  stripe_subscription_id text,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  status               text        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz,
  CONSTRAINT subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT subscriptions_reduction CHECK (seat_count_next IS NULL OR seat_count_next <= seat_count),
  CONSTRAINT subscriptions_cancellation CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

/* One live subscription per organisation; a cancelled one stays for the record. */
CREATE UNIQUE INDEX subscriptions_live ON subscriptions (organisation_id) WHERE cancelled_at IS NULL;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE  ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON subscriptions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON subscriptions TO silo_app;

/*
 * `source_id` HAS NO FOREIGN KEY, because it names one of two parents: a
 * subscription today, a contract once those exist. `source` says which.
 *
 * `daily_token_limit` NULL MEANS NO LIMIT, which is a real answer on a
 * negotiated contract and is not the same as zero.
 */
CREATE TABLE entitlements (
  id                     uuid        PRIMARY KEY,
  organisation_id        uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  seats                  integer     NOT NULL CHECK (seats >= 0),
  tokens_per_seat        integer     NOT NULL CHECK (tokens_per_seat >= 0),
  simulations_per_seat   integer     NOT NULL CHECK (simulations_per_seat >= 0),
  daily_token_limit      integer     CHECK (daily_token_limit > 0),
  storage_included_bytes bigint      NOT NULL DEFAULT 0 CHECK (storage_included_bytes >= 0),
  capabilities           text[]      NOT NULL DEFAULT '{}',
  source                 text        NOT NULL CHECK (source IN ('subscription', 'contract')),
  source_id              uuid        NOT NULL,
  effective_from         timestamptz NOT NULL DEFAULT now(),
  effective_to           timestamptz,
  CONSTRAINT entitlements_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);

/* One current version per organisation. The rest are closed and kept. */
CREATE UNIQUE INDEX entitlements_current ON entitlements (organisation_id) WHERE effective_to IS NULL;
CREATE INDEX entitlements_history ON entitlements (organisation_id, effective_from DESC);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE  ROW LEVEL SECURITY;
CREATE POLICY entitlements_tenant ON entitlements
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* UPDATE closes a version's window. Nothing else about it may move. */
GRANT SELECT, INSERT, UPDATE ON entitlements TO silo_app;

CREATE OR REPLACE FUNCTION entitlements_closed_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id                     IS DISTINCT FROM OLD.id
  OR NEW.organisation_id        IS DISTINCT FROM OLD.organisation_id
  OR NEW.seats                  IS DISTINCT FROM OLD.seats
  OR NEW.tokens_per_seat        IS DISTINCT FROM OLD.tokens_per_seat
  OR NEW.simulations_per_seat   IS DISTINCT FROM OLD.simulations_per_seat
  OR NEW.daily_token_limit      IS DISTINCT FROM OLD.daily_token_limit
  OR NEW.storage_included_bytes IS DISTINCT FROM OLD.storage_included_bytes
  OR NEW.capabilities           IS DISTINCT FROM OLD.capabilities
  OR NEW.source                 IS DISTINCT FROM OLD.source
  OR NEW.source_id              IS DISTINCT FROM OLD.source_id
  OR NEW.effective_from         IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'An entitlement version is written once; only its window closes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entitlements_closed_once
  BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION entitlements_closed_once();

/*
 * §10 — seeing what you are entitled to and what it costs is not the same
 * permission as changing it. `billing.manage`, `seat.release` and
 * `tokens.purchase` already exist; this is the read.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('billing.view', 'billing', 'See invoices, usage and allowances', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'billing.view'
  FROM roles r
 WHERE r.system_role AND r.name IN ('Super admin', 'Admin')
ON CONFLICT DO NOTHING;
