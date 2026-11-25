/*
 * 090 — how often a plan may schedule a check.
 *
 * ── Automations §7: "Minimum interval per plan" ────────────────────────────
 *
 * "because a question running every minute is a cost the customer did not
 * intend." The cost is not ours in the usual sense — §7 also says runs are not
 * metered — it is the customer's own systems being asked, every minute,
 * forever, by something nobody is watching.
 *
 * ── THE NUMBERS ARE INVENTED, AND SAYING SO IS THE POINT ───────────────────
 *
 * §7 says the interval is per plan and gives none. These are a first answer,
 * not a quoted term: sixty minutes on standard, fifteen on business, five where
 * a contract says otherwise. They live in entitlements rather than in the code
 * precisely because they will be wrong — a contract can already set them per
 * customer without a deploy, which is what `entitlements` is for.
 *
 * Unlike §5's simulation price, which is refused rather than guessed, a limit
 * guessed low is recoverable: it refuses a schedule somebody then asks about. A
 * price guessed low appears on an invoice as though it had been agreed.
 */

ALTER TABLE entitlements
  ADD COLUMN minimum_interval_minutes integer NOT NULL DEFAULT 60
    CHECK (minimum_interval_minutes BETWEEN 1 AND 1440);

/*
 * Existing rows keep the default, which is the most restrictive of the three.
 * Loosening somebody's limit is a change they will not complain about;
 * tightening one they are already inside would pause nothing but would refuse
 * their next edit, so the safe direction on a backfill is the strict one.
 */
UPDATE entitlements e
   SET minimum_interval_minutes = 15
  FROM subscriptions s
 WHERE s.organisation_id = e.organisation_id
   AND e.effective_to IS NULL
   AND s.plan IN ('business', 'enterprise');
