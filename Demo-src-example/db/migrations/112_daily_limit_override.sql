/*
 * 112 — an organisation's own cap on how much one person may spend in a day.
 *
 * ── BILLING §2 SAYS "CONFIGURABLE" AND NOTHING COULD CONFIGURE IT ─────────
 *
 * The daily limit comes from the plan: twenty on Standard, forty on Business,
 * and none at all on Enterprise. So the plan with the most to lose from a
 * runaway loop is the one with no brake, and an organisation that wanted its
 * people held to less than the plan allows had nowhere to say so.
 *
 * ── STRICTER, NEVER LOOSER, AND THE CEILING IS THE PLAN ───────────────────
 *
 * The same floor mechanic as approval policy and scope sharing: what is bought
 * is the ceiling and a local setting may only reduce it. The service takes the
 * smaller of the two, so this column cannot buy capability — which is why it is
 * safe for `billing.manage` rather than something rarer.
 *
 * NULL IS "WHATEVER THE PLAN SAYS", which is a different fact from a limit of
 * none: on Enterprise the plan says none, and setting a number here is how an
 * Enterprise organisation gets a brake at all.
 */

ALTER TABLE organisations
  ADD COLUMN daily_token_limit integer CHECK (daily_token_limit > 0);
