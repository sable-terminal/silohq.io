/*
 * 082 — what a Silo held and scanned in a period, and what that cost us.
 *
 * ── Cost plus ten per cent, with the cost visible ──────────────────────────
 *
 * Billing §6: "The underlying cost is recorded per line. A customer asking what
 * they are paying for sees the provider cost and the 10%, not a blended rate.
 * This is the only place in the pricing model where cost is disclosed, and it
 * is deliberate: 10% over cost is a claim that only means something if the cost
 * is visible." So the provider's cost is a column, the rates that produced it
 * are a column, and the charge is derived from both rather than stored alone.
 *
 * ── In arrears, because neither figure is known in advance ─────────────────
 *
 * Bytes held is measured, not promised; bytes scanned is whatever the questions
 * asked for. A measurement is a reading taken at a moment, and the period it
 * belongs to is the month it was taken in.
 *
 * ── Sovereign pays its own rate ────────────────────────────────────────────
 *
 * §6: "Data-residency endpoints cost more than global ones, so a sovereign
 * customer's storage line is higher, and the plus 10% is applied to their
 * actual rate." `residency` records which rate card was used, so the line can
 * be read back years later without guessing what the deployment was.
 */

CREATE TABLE storage_measurements (
  id                 uuid        PRIMARY KEY,
  organisation_id    uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  silo_id            uuid        NOT NULL REFERENCES siloes(id) ON DELETE RESTRICT,
  /* The month this reading belongs to, at its first instant. */
  period_start       timestamptz NOT NULL,
  bytes_held         bigint      NOT NULL CHECK (bytes_held >= 0),
  /* What this period's questions scanned: the difference from the last reading. */
  bytes_scanned      bigint      NOT NULL CHECK (bytes_scanned >= 0),
  /* The running total the difference was taken from, so the next reading can do the same. */
  scanned_cumulative bigint      NOT NULL CHECK (scanned_cumulative >= 0),
  /* What the provider charges us for it, in pence, and the rates that produced it. */
  provider_cost_pence integer    NOT NULL CHECK (provider_cost_pence >= 0),
  rates              jsonb       NOT NULL,
  residency          text        NOT NULL,
  measured_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (silo_id, period_start)
);

CREATE INDEX storage_measurements_by_org ON storage_measurements (organisation_id, period_start DESC);

ALTER TABLE storage_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_measurements FORCE  ROW LEVEL SECURITY;
CREATE POLICY storage_measurements_tenant ON storage_measurements
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

/* A reading is taken once per period and then updated as the month goes on. */
GRANT SELECT, INSERT, UPDATE ON storage_measurements TO silo_app;
