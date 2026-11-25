/**
 * §7.3 — "last quarter" as an actual pair of instants.
 *
 * ── Three problems wearing one name ────────────────────────────────────────
 *
 * PARSING. Turning an English period into a range, against the organisation's
 * own calendar rather than the caller's machine.
 *
 * WHICH FIELD. A range is meaningless until something says which column it
 * applies to, and most concepts have several. That is the concept's business
 * and lives in `concept_time_fields`; this file resolves the range alone.
 *
 * COMPARABILITY. Two systems with different clocks cannot be put in order
 * across the boundary. A RANGE is safe — each source filters its own field in
 * its own terms — and a sequence claim is not. So ranges are compilable now and
 * cross-system ordering waits for the time work proper.
 *
 * ── The expression and the resolution are stored separately ────────────────
 *
 * A saved view re-running must not silently mean a different period than it
 * did. Keeping only the range freezes "last quarter" to one quarter forever;
 * keeping only the words means nobody can see what a past answer covered. So a
 * plan records both, re-resolves the words on each run, and the answer can say
 * which quarter it took them to mean.
 */

export type Period = {
  /** What the asker said, kept verbatim so it can be resolved again. */
  expression: string;
  /** Inclusive. */
  from: Date;
  /** EXCLUSIVE, so consecutive periods neither overlap nor leave a gap. */
  until: Date;
};

export type PeriodRefusal = { reason: string; expression: string };

/**
 * An organisation's own calendar.
 *
 * THE FINANCIAL YEAR IS NOT ALWAYS JANUARY, and a company whose year starts in
 * April means something different by "last quarter" than the calendar does.
 * Getting that wrong shifts every figure by three months and looks entirely
 * plausible.
 */
export type Calendar = {
  /** IANA zone. Midnight is midnight there, not where the server runs. */
  timeZone: string;
  /** 1–12. The month the financial year begins. */
  yearStartsInMonth: number;
};

export const DEFAULT_CALENDAR: Calendar = { timeZone: 'UTC', yearStartsInMonth: 1 };

const DAY = 86_400_000;

/**
 * Resolve an English period against a calendar and an instant.
 *
 * `now` IS PASSED IN, NEVER READ. The engine is arithmetic over what it is
 * handed — a function that read the clock could not be tested for the boundary
 * cases that matter, and those are the ones that move a figure into the wrong
 * quarter.
 *
 * REFUSED RATHER THAN GUESSED. A phrase this does not recognise is not
 * approximated to something nearby: "recently" has no defensible range, and
 * inventing one produces a figure somebody acts on.
 */
export function resolvePeriod(
  expression: string,
  now: Date,
  calendar: Calendar = DEFAULT_CALENDAR,
): Period | PeriodRefusal {
  const said = expression.trim().toLowerCase();
  const zone = calendar.timeZone;

  /**
   * The instant at which local midnight on that date occurs.
   *
   * ── THE OFFSET IS TAKEN AT THE TARGET, NOT AT `now` ──────────────────────
   *
   * The first version computed one offset — the zone's offset at the moment the
   * question was asked — and applied it to BOTH ends of the range. Asked in
   * August, "this year" in London came back starting at 2025-12-31T23:00Z: an
   * hour early, because January is GMT and August is BST. Every range spanning
   * a clock change was an hour wrong at one end, which for an append-only
   * ledger is an hour of records in the wrong period.
   *
   * ── AND MIDNIGHT DOES NOT ALWAYS EXIST ───────────────────────────────────
   *
   * The version after that guessed an instant, re-read the offset there, and
   * corrected ONCE — which assumes the corrected instant is itself valid. In
   * zones whose clocks jump AT midnight, 00:00 never happens: Santiago goes
   * from 23:59:59 on the 5th of September straight to 01:00:00 on the 6th.
   * There the correction walked backwards into the PREVIOUS day, and because
   * every other helper re-reads the local date off the instant it is handed,
   * the error compounded — "today" came back as a range of ZERO LENGTH, which
   * reads in an answer as "nothing happened today", and "yesterday" came back
   * as forty-seven hours.
   *
   * So both candidates are computed and CHECKED, rather than one being
   * trusted:
   *   — one reads back as local midnight: use it;
   *   — both do (the hour that repeats when clocks go back): take the earlier,
   *     so consecutive days still abut exactly;
   *   — neither does (the hour that never happens): take the later, which is
   *     the first instant the local day actually has.
   */
  const midnightOn = (year: number, month: number, day: number): Date => {
    const naive = Date.UTC(year, month, day);

    /* Placed by the offset a day either side, which is what differs across a
       transition. Reading the offset AT the target is what fails when the
       target is an instant the zone skips. */
    const offsetBefore = offsetOf(zone, new Date(naive - DAY));
    const offsetAfter = offsetOf(zone, new Date(naive + DAY));

    /* The ordinary case: no transition anywhere near, one answer. */
    if (offsetBefore === offsetAfter) return new Date(naive - offsetBefore);

    /*
     * ── OTHERWISE, THE FIRST INSTANT THAT IS ACTUALLY ON THAT DAY ───────────
     *
     * Comparing two candidates against local MIDNIGHT is not general enough,
     * because a day need not begin at midnight. Toronto's clocks went forward
     * ACROSS midnight on the 31st of March 1919 — 23:59 became 00:30 — so the
     * day began half an hour into itself, both candidates were wrong, and
     * "today" excluded the 00:45 at which it was being asked.
     *
     * The day begins at the first instant whose LOCAL DATE is that date, which
     * is true whatever the clocks did. It is bracketed by the two candidates,
     * so a handful of steps finds it, and only on the days where the offsets
     * differ at all — every other day takes the line above.
     */
    const asNumber = (at: Date) => {
      const local = localOn(at);
      return local.year * 10_000 + local.month * 100 + local.day;
    };

    const target = year * 10_000 + month * 100 + day;

    let low = naive - Math.max(offsetBefore, offsetAfter);
    let high = naive - Math.min(offsetBefore, offsetAfter);

    /* Outside the bracket entirely: the whole local day was skipped. Return the
       later edge, which `dayExists` then reads as a day of no length. */
    if (asNumber(new Date(high)) < target) return new Date(high);
    if (asNumber(new Date(low)) >= target) return new Date(low);

    while (high - low > 1000) {
      const middle = low + Math.floor((high - low) / 2);
      if (asNumber(new Date(middle)) >= target) high = middle;
      else low = middle;
    }

    return new Date(high);
  };

  /** The local calendar date at an instant. */
  const localOn = (at: Date) => {
    const local = new Date(at.getTime() + offsetOf(zone, at));
    return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
  };

  const startOfDay = (at: Date) => {
    const { year, month, day } = localOn(at);
    return midnightOn(year, month, day);
  };

  const addDays = (at: Date, days: number) => {
    /* CALENDAR DAYS, NOT 24-HOUR BLOCKS. Adding milliseconds across a clock
       change lands an hour off the day boundary it was aiming at. */
    const { year, month, day } = localOn(at);
    return midnightOn(year, month, day + days);
  };

  /**
   * The same day of the month, N months away, clamped to a day that exists.
   *
   * THE 31st OF MARCH MINUS ONE MONTH IS THE 28th OF FEBRUARY, not the 3rd of
   * March. `Date.UTC` rolls an impossible day forward, which would move a
   * month-long period past the boundary it was aiming at.
   */
  const addMonths = (at: Date, months: number) => {
    const { year, month, day } = localOn(at);
    const lastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
    return midnightOn(year, month + months, Math.min(day, lastDay));
  };

  const startOfMonth = (at: Date, months = 0) => {
    const { year, month } = localOn(at);
    return midnightOn(year, month + months, 1);
  };

  /** The financial quarter containing `at`, offset by `quarters`. */
  const startOfQuarter = (at: Date, quarters = 0) => {
    const { month } = localOn(at);
    /* Months since the financial year began, so a year starting in April makes
       April–June the first quarter rather than the second. */
    const since = (month - (calendar.yearStartsInMonth - 1) + 12) % 12;
    return startOfMonth(at, -(since % 3) + quarters * 3);
  };

  const startOfYear = (at: Date, years = 0) => {
    const { year, month } = localOn(at);
    const began = month >= calendar.yearStartsInMonth - 1;
    return midnightOn(year + (began ? 0 : -1) + years, calendar.yearStartsInMonth - 1, 1);
  };

  /**
   * A range, or a refusal if it turns out not to be one.
   *
   * A ZERO-LENGTH PERIOD IS NOT AN EMPTY ANSWER, IT IS A BROKEN QUESTION. Samoa
   * skipped the 30th of December 2011, so on the 31st "yesterday" named a day
   * with no instants in it and came back `from === until` — matching nothing,
   * which reads as "nothing happened yesterday" for the whole country.
   *
   * Checked HERE rather than at each branch, because every branch can produce
   * one: a named day that was skipped, a relative count landing on one, a range
   * whose ends collapse.
   */
  const period = (from: Date, until: Date): Period | PeriodRefusal =>
    until <= from
      ? {
          reason: `${expression.trim()} names no time in this calendar.`,
          expression,
        }
      : { expression: expression.trim(), from, until };

  if (said === 'today') return period(startOfDay(now), addDays(startOfDay(now), 1));
  if (said === 'yesterday') return period(addDays(startOfDay(now), -1), startOfDay(now));

  if (said === 'this month') return period(startOfMonth(now), startOfMonth(now, 1));
  if (said === 'last month') return period(startOfMonth(now, -1), startOfMonth(now));

  if (said === 'this quarter') return period(startOfQuarter(now), startOfQuarter(now, 1));
  if (said === 'last quarter') return period(startOfQuarter(now, -1), startOfQuarter(now));

  if (said === 'this year') return period(startOfYear(now), startOfYear(now, 1));
  if (said === 'last year') return period(startOfYear(now, -1), startOfYear(now));

  /*
   * YEAR TO DATE ENDS NOW, NOT AT THE END OF TODAY. A total "so far this year"
   * that included the rest of today would answer a question about the future,
   * and for an append-only ledger the difference is every row written since
   * midnight.
   */
  if (said === 'year to date' || said === 'ytd') return period(startOfYear(now), now);

  const relative = /^(?:in |over |for )?the (?:past|last) (\d+) (day|week|month|year)s?$/.exec(said);
  if (relative) {
    const count = Number(relative[1]);
    const unit = relative[2];

    if (count < 1 || count > 1000) {
      return { reason: `${count} is not a period this can resolve.`, expression };
    }

    /*
     * ── ALL FOUR UNITS ROLL, AND TWO OF THEM DID NOT ─────────────────────────
     *
     * Days and weeks counted back from today. Months and years counted back to
     * the START OF A MONTH or of a financial year, so "the past N months" meant
     * "this month so far, plus N-1 whole ones".
     *
     * On the first of January that made "the past 1 year" ONE DAY LONG, and
     * "the past 1 month" one day long, and both returned a real total over it.
     * On the fifteenth of June "the past 1 year" was a hundred and sixty-six
     * days — year to date wearing the name of a year.
     *
     * Nobody asking what they spent in the past year means either of those.
     */
    const until = addDays(now, 1);
    if (unit === 'day') return period(addDays(until, -count), until);
    if (unit === 'week') return period(addDays(until, -count * 7), until);
    if (unit === 'month') return period(addMonths(until, -count), until);
    return period(addMonths(until, -count * 12), until);
  }

  /**
   * A calendar date, or nothing.
   *
   * `Date.UTC` ROLLS OVER RATHER THAN REFUSING, so the thirtieth of February
   * quietly becomes the second of March and a NaN check never fires — a typo'd
   * date answered confidently about a different period. The components are
   * compared back to catch it.
   */
  const dateOf = (text: string): { year: number; month: number; day: number } | null => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!parts) return null;

    const year = Number(parts[1]);
    const month = Number(parts[2]) - 1;
    const day = Number(parts[3]);

    const roundTrip = new Date(Date.UTC(year, month, day));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month ||
      roundTrip.getUTCDate() !== day
    ) {
      return null;
    }

    return { year, month, day };
  };

  /**
   * Whether that local date happened in this zone at all.
   *
   * SAMOA SKIPPED THE 30th OF DECEMBER 2011 — it crossed the date line, and the
   * day has no instants. Kiritimati did the same in 1994, Kwajalein in 1993.
   * Asked about one, the range came back with `until` equal to `from` and the
   * refusal blamed the caller for putting the dates the wrong way round, which
   * sends somebody hunting for a typo that is not there.
   *
   * NOT THE SAME QUESTION AS WHETHER MIDNIGHT EXISTS. Santiago has no 00:00 on
   * the 6th of September and a perfectly real day starting at 01:00; the test
   * is whether the day has any length at all.
   */
  const dayExists = (year: number, month: number, day: number) =>
    midnightOn(year, month, day) < midnightOn(year, month, day + 1);

  const since = /^since (\d{4}-\d{2}-\d{2})$/.exec(said);
  if (since) {
    const on = dateOf(since[1]!);
    if (!on) return { reason: `${since[1]} is not a date.`, expression };
    if (!dayExists(on.year, on.month, on.day)) {
      return { reason: `${since[1]} did not happen in this calendar.`, expression };
    }

    const from = midnightOn(on.year, on.month, on.day);
    const until = addDays(now, 1);

    /*
     * A DATE IN THE FUTURE IS A BACKWARDS RANGE, and `between` has refused that
     * since it was written while this branch did not — so "since 2036-01-01"
     * returned a period of minus three thousand days. It matches nothing, which
     * reads as "there was no activity": the one answer this must not give by
     * accident, and the reason the guard exists at all.
     */
    if (until <= from) {
      return { reason: `${since[1]} has not happened yet.`, expression };
    }

    return period(from, until);
  }

  const between = /^between (\d{4}-\d{2}-\d{2}) and (\d{4}-\d{2}-\d{2})$/.exec(said);
  if (between) {
    const first = dateOf(between[1]!);
    const last = dateOf(between[2]!);

    if (!first || !last) {
      return { reason: `${first ? between[2] : between[1]} is not a date.`, expression };
    }

    const missing = !dayExists(first.year, first.month, first.day)
      ? between[1]
      : !dayExists(last.year, last.month, last.day)
        ? between[2]
        : null;

    if (missing) return { reason: `${missing} did not happen in this calendar.`, expression };

    const from = midnightOn(first.year, first.month, first.day);
    /* Inclusive at both ends, so the last day named is included — which is an
       exclusive bound of the day after it. */
    const until = midnightOn(last.year, last.month, last.day + 1);

    if (until <= from) {
      /* A range ending before it starts returns nothing and reads as "there was
         no activity", which is the one answer it must not give by accident. */
      return { reason: 'That period ends before it begins.', expression };
    }

    return period(from, until);
  }

  return {
    reason: `"${expression.trim()}" is not a period this understands. Give a range, or a phrase like "last quarter".`,
    expression,
  };
}

export const isPeriod = (result: Period | PeriodRefusal): result is Period => 'from' in result;

/** One instant, and the words it was resolved from. */
export type Moment = { expression: string; at: Date };

/**
 * Siloes (136) — a moment, from words that name a span of time.
 *
 * "AS AT LAST QUARTER" IS THE CLOSE OF IT; "SINCE MONDAY" IS THE START OF IT.
 * So a moment is one edge of the period the words resolve to, and the caller
 * says which. A bare date is that day. The same resolver, the same calendar,
 * and the same rule that the model carries the words and never the dates.
 *
 * A MOMENT THAT HAS NOT HAPPENED IS REFUSED, and the end of a span still under
 * way is now: nothing can be said of how things stood tomorrow.
 */
export function resolveMoment(
  expression: string,
  now: Date,
  calendar: Calendar = DEFAULT_CALENDAR,
  edge: 'start' | 'end' = 'end',
): Moment | PeriodRefusal {
  const said = expression.trim();
  const span = resolvePeriod(/^\d{4}-\d{2}-\d{2}$/.test(said) ? `between ${said} and ${said}` : said, now, calendar);
  if (!isPeriod(span)) return { reason: span.reason, expression: said };

  const at = edge === 'start' ? span.from : span.until;
  if (edge === 'start' && at.getTime() > now.getTime()) return { reason: `${said} has not happened yet.`, expression: said };

  return { expression: said, at: at.getTime() > now.getTime() ? now : at };
}

export const isMoment = (result: Moment | PeriodRefusal): result is Moment => 'at' in result;

/**
 * How far the zone is from UTC at that instant.
 *
 * COMPUTED AT THE INSTANT, NOT FIXED, so a period spanning a daylight-saving
 * change resolves against the offset that actually applied. `Intl` is what
 * knows the rules; hard-coding an offset makes March and October wrong.
 */
function offsetOf(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const value = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? '0');

    const asUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour') === 24 ? 0 : value('hour'),
      value('minute'),
      value('second'),
    );

    return asUtc - at.getTime();
  } catch {
    /* An unknown zone is not worth failing a question over, and UTC is the
       honest fallback rather than the server's own zone — which would make the
       answer depend on where it happened to run. */
    return 0;
  }
}
