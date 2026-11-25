/*
 * §7.3 — the calendar "last quarter" is measured against.
 *
 * ── The default is a guess, and it was being made silently ─────────────────
 *
 * `resolvePeriod` already takes a calendar and defaults it to UTC with a
 * January year start. Nothing stored one, so every organisation got that
 * default whether or not it was true of them — and a company whose financial
 * year starts in April means something different by "last quarter" than the
 * calendar does.
 *
 * THE FAILURE IS SILENT AND PLAUSIBLE. The figures come back real and
 * correctly totalled, three months out. Nobody checks a total that looks
 * roughly right.
 *
 * ── Why columns rather than a table ────────────────────────────────────────
 *
 * There is exactly one calendar per organisation, it is read on every question
 * that mentions a period, and it has no history worth keeping — a company that
 * changes its financial year is restating its own reporting, not amending a
 * log. A table would be a join on the hot path to hold at most one row.
 */

ALTER TABLE organisations
  /*
   * IANA, NOT AN OFFSET. "+01:00" is wrong for half the year in most of the
   * world, and storing it would reintroduce the daylight-saving bug at the
   * schema level rather than in the arithmetic.
   *
   * THE CHECK IS SHAPE ONLY. Whether a zone EXISTS is a question for
   * `pg_timezone_names`, and a CHECK cannot contain a subquery — so the real
   * validation is at the write, against the same zone database the resolver
   * uses. This constraint stops a value that could never be a zone name at
   * all; it does not pretend to stop a typo.
   */
  ADD COLUMN time_zone             text     NOT NULL DEFAULT 'UTC'
                                            CHECK (time_zone ~ '^[A-Za-z][A-Za-z0-9+_-]{0,31}(/[A-Za-z0-9+_-]{1,31}){0,2}$'),

  /*
   * 1–12, the month the financial year begins. Not a date: no organisation's
   * year starts on the 6th of April for reporting purposes even where its tax
   * year does, and allowing a day would make every quarter boundary a
   * different arithmetic.
   */
  ADD COLUMN year_starts_in_month  smallint NOT NULL DEFAULT 1
                                            CHECK (year_starts_in_month BETWEEN 1 AND 12);

COMMENT ON COLUMN organisations.time_zone IS
  'IANA zone. Midnight is midnight there, not where the server runs.';
COMMENT ON COLUMN organisations.year_starts_in_month IS
  'The month the financial year begins. 4 makes April-June the first quarter.';
