/**
 * Five-field cron expressions and next-run calculation.
 *
 * HAND-ROLLED RATHER THAN A DEPENDENCY, because the surface actually needed is
 * small and the alternatives bring timezone handling that has to be understood
 * anyway. Five fields, `*`, ranges, steps and lists. No seconds field, no `@`
 * macros, no `L` or `W` — a schedule nobody can read is a schedule nobody can
 * audit, and this drives writes to customer systems.
 *
 * MINUTE HOUR DAY-OF-MONTH MONTH DAY-OF-WEEK.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const RANGES: Array<[keyof CronFields, number, number]> = [
  ['minutes', 0, 59],
  ['hours', 0, 23],
  ['daysOfMonth', 1, 31],
  ['months', 1, 12],
  ['daysOfWeek', 0, 6],
];

function parseField(spec: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);

    let from = min;
    let to = max;

    if (range !== '*') {
      const bounds = range!.split('-');
      from = Number(bounds[0]);
      to = bounds.length > 1 ? Number(bounds[1]) : from;
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`Invalid range "${range}"`);
      if (from < min || to > max || from > to) throw new Error(`"${range}" is outside ${min}-${max}`);
    }

    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values;
}

export function parse(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields, received ${parts.length}: "${expression}"`);
  }

  const fields = {} as CronFields;
  RANGES.forEach(([name, min, max], i) => {
    fields[name] = parseField(parts[i]!, min, max);
  });
  return fields;
}

/*
 * ── WALL CLOCK, NOT ELAPSED TIME ──────────────────────────────────────────
 *
 * Automations §7: "Timezone is the organisation's, not the server's. A daily
 * run at 9am means their 9am." So the fields are matched against the local
 * clock in a named zone, and the answer is still a real instant.
 *
 * THE OFFSET IS READ, NEVER ASSUMED. `Intl` is the only thing in the runtime
 * that knows when Europe/London stopped being +00:00, and hard-coding an offset
 * is how a daily 9am job silently becomes 10am for seven months of the year.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's offset from UTC at a given instant, in minutes. */
function offsetMinutesAt(at: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

  /*
   * `hour` COMES BACK AS 24 AT MIDNIGHT in some environments under `hour12:
   * false`, which would put the reconstructed instant a day out. Normalised
   * here rather than trusted.
   */
  const hour = read('hour') % 24;

  const asIfUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/**
 * The next time this expression fires, at or after `from`, in a named zone.
 *
 * DAY-OF-MONTH AND DAY-OF-WEEK ARE OR'd WHEN BOTH ARE RESTRICTED, which is
 * surprising and is what every cron implementation does. `0 0 1 * 1` fires on the
 * first of the month AND every Monday, not on Mondays that are the first.
 * Deviating would make expressions copied from a crontab behave differently here.
 *
 * ── The two clock changes, and what each one does ─────────────────────────
 *
 * SPRING FORWARD SKIPS. On the morning the clocks go forward, 01:30 local does
 * not happen, so `30 1 * * *` does not run that day. That is correct: the
 * schedule names a wall-clock time, and that time did not occur. Inventing a
 * run at 02:30 would be the product deciding the customer meant something else.
 *
 * AUTUMN BACK FIRES ONCE. On the morning the clocks go back, 01:30 local
 * happens twice, an hour apart. The second is refused by comparing the
 * candidate's local stamp with `from`'s: a schedule fires once per local minute
 * it names, and a daily job running twice would propose the same change twice.
 *
 * ITERATES MINUTES IN LOCAL TIME, WITH A CEILING. Four years covers every
 * leap-year case; an expression matching nothing (30 February) returns null
 * rather than looping. The arithmetic is on a shifted `Date` read through its
 * UTC getters, so the loop stays cheap and `Intl` is consulted once per
 * candidate rather than once per minute.
 */
export function nextRun(expression: string, from: Date = new Date(), timeZone = 'UTC'): Date | null {
  const fields = parse(expression);

  const offsetAtStart = offsetMinutesAt(from, timeZone);
  const shift = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

  /* The wall clock `from` was at, so the repeated hour can be recognised. */
  const fromLocal = shift(from, offsetAtStart);
  const stampOf = (local: Date) =>
    `${local.getUTCFullYear()}-${local.getUTCMonth()}-${local.getUTCDate()}T${local.getUTCHours()}:${local.getUTCMinutes()}`;
  const fromStamp = stampOf(fromLocal);

  const local = new Date(fromLocal.getTime());
  local.setUTCSeconds(0, 0);
  local.setUTCMinutes(local.getUTCMinutes() + 1);

  const limit = 4 * 366 * 24 * 60;

  for (let i = 0; i < limit; i++) {
    const domRestricted = fields.daysOfMonth.size < 31;
    const dowRestricted = fields.daysOfWeek.size < 7;

    const dayMatches =
      domRestricted && dowRestricted
        ? fields.daysOfMonth.has(local.getUTCDate()) || fields.daysOfWeek.has(local.getUTCDay())
        : fields.daysOfMonth.has(local.getUTCDate()) && fields.daysOfWeek.has(local.getUTCDay());

    if (
      fields.months.has(local.getUTCMonth() + 1) &&
      dayMatches &&
      fields.hours.has(local.getUTCHours()) &&
      fields.minutes.has(local.getUTCMinutes())
    ) {
      /*
       * Back to a real instant. The offset may have changed since `from`, so it
       * is recomputed at the candidate and the local clock re-read: if the
       * second reading disagrees, this wall-clock minute did not exist and the
       * day is skipped rather than moved.
       */
      const guess = shift(local, -offsetAtStart);
      const offsetThere = offsetMinutesAt(guess, timeZone);
      const instant = offsetThere === offsetAtStart ? guess : shift(local, -offsetThere);

      const settled = shift(instant, offsetMinutesAt(instant, timeZone));
      const occurred =
        settled.getUTCHours() === local.getUTCHours() && settled.getUTCMinutes() === local.getUTCMinutes();

      if (occurred && instant > from && stampOf(settled) !== fromStamp) return instant;
    }

    local.setUTCMinutes(local.getUTCMinutes() + 1);
  }

  return null;
}

export function isValid(expression: string): boolean {
  try {
    parse(expression);
    return true;
  } catch {
    return false;
  }
}
