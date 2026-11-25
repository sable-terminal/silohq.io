/*
 * §2.4 (132) — whether Silo has looked for a connection's records in the others.
 *
 * ── WHY IT IS A COLUMN AND NOT A STEP IN CONFIRMING ───────────────────────
 *
 * Joining systems means reading a page of each of them, which takes as long as
 * the slowest. Doing it inside "confirm this connection" made a button that
 * used to answer at once wait on every other system the customer has — and
 * fail to say so when one of them was slow.
 *
 * So confirming a connection only leaves this empty, and the looking happens
 * wherever there is already something to wait for: the page that confirmed it
 * asks in the background, and the next answer to be written up does it beside
 * the model call. Whichever gets there first claims the connection by setting
 * this, so two of them never look at once.
 *
 * NULL FOR EVERYTHING ALREADY CONNECTED, deliberately: an organisation with two
 * systems and no concept across them is exactly who this was built for, and
 * its next answer joins them.
 */
ALTER TABLE connections ADD COLUMN joined_at timestamptz;
