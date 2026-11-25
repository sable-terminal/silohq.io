/*
 * 080 — token allowances, balances and every charge against them.
 *
 * ── Per membership, never pooled ───────────────────────────────────────────
 *
 * Billing §4: "Allowances do not pool across seats and do not roll over." A
 * period's allowance belongs to one membership and ends with the period, so the
 * allowance is a row per membership per period rather than a counter on the
 * organisation. Pooling would make a team of ten with one heavy user look
 * identical to ten ordinary ones, which is not what was sold.
 *
 * ── Three balances, consumed in one order ──────────────────────────────────
 *
 * §4: "onboarding grant, then period allowance, then purchased balance." The
 * grant is outside the allowance so a trial does not eat the first month; the
 * purchased balance is last because it does not expire, and spending it before
 * an allowance that does would quietly waste what was bought.
 *
 * ── Every charge is a row ──────────────────────────────────────────────────
 *
 * Append-only, one row per pool a charge drew from, sharing a correlation id.
 * An invoice is a sum over these; a customer asking what used their allowance
 * gets the operations, not a total somebody has to trust.
 */

CREATE TABLE token_allowances (
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  granted         integer     NOT NULL CHECK (granted >= 0),
  consumed        integer     NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  /* Null means no daily limit, which only a contract gives. */
  daily_limit     integer     CHECK (daily_limit > 0),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, period_start),
  CONSTRAINT token_allowances_period CHECK (period_end > period_start)
);

CREATE INDEX token_allowances_current ON token_allowances (organisation_id, period_end DESC);

ALTER TABLE token_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_allowances FORCE  ROW LEVEL SECURITY;
CREATE POLICY token_allowances_tenant ON token_allowances
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON token_allowances TO silo_app;

/*
 * WHAT DOES NOT EXPIRE. The onboarding grant and anything purchased; §4 says
 * purchased tokens have no expiry, and a balance that quietly lapsed would be
 * money taken for nothing.
 *
 * `auto_top_up` IS OPT-IN AND LIVES HERE, per membership, because it is the
 * balance it tops up. Off means exhaustion refuses and says so.
 */
CREATE TABLE token_balances (
  membership_id      uuid        PRIMARY KEY REFERENCES memberships(id) ON DELETE RESTRICT,
  organisation_id    uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  purchased_remaining integer    NOT NULL DEFAULT 0 CHECK (purchased_remaining >= 0),
  grant_remaining    integer     NOT NULL DEFAULT 0 CHECK (grant_remaining >= 0),
  auto_top_up        boolean     NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE token_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_balances FORCE  ROW LEVEL SECURITY;
CREATE POLICY token_balances_tenant ON token_balances
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON token_balances TO silo_app;

/*
 * `weight` IS WHAT WAS CHARGED, NOT WHAT THE OPERATION COSTS TODAY. The table
 * of weights can be repriced; what somebody was charged last March cannot.
 *
 * `correlation_id` TIES THE PARTS OF ONE CHARGE TOGETHER — a compile that took
 * one token from a grant and two from an allowance is three tokens, once.
 */
CREATE TABLE token_transactions (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  operation       text        NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  weight          integer     NOT NULL CHECK (weight > 0),
  source          text        NOT NULL CHECK (source IN ('grant', 'allowance', 'purchased')),
  correlation_id  uuid        NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX token_transactions_by_member ON token_transactions (membership_id, occurred_at DESC);
CREATE INDEX token_transactions_by_org ON token_transactions (organisation_id, occurred_at DESC);

ALTER TABLE token_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY token_transactions_tenant ON token_transactions
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* APPEND-ONLY. What was charged is evidence; no UPDATE, no DELETE. */
GRANT SELECT, INSERT ON token_transactions TO silo_app;

/*
 * §11 — what was bought, by whom, and whether it was an automatic top-up.
 *
 * `auto` IS ITS OWN COLUMN rather than a note: "how much of our spend was
 * automatic" is the first question anybody asks about a top-up setting, and it
 * must be answerable without inferring it from timing.
 */
CREATE TABLE purchases (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  kind            text        NOT NULL CHECK (kind IN ('tokens', 'simulations')),
  quantity        integer     NOT NULL CHECK (quantity > 0),
  amount_pence    integer     NOT NULL CHECK (amount_pence >= 0),
  auto            boolean     NOT NULL DEFAULT false,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX purchases_by_org ON purchases (organisation_id, occurred_at DESC);

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases FORCE  ROW LEVEL SECURITY;
CREATE POLICY purchases_tenant ON purchases
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON purchases TO silo_app;
