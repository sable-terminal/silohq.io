/**
 * Numbers, money and dates as a reader expects them.
 *
 * en-GB BY DEFAULT AND NEVER THE SERVER'S LOCALE. `toLocaleString()` with no
 * locale uses whatever the process is set to, which is a property of the machine
 * — so the same figure renders differently depending on which container answered.
 * The default is explicit and overridable per organisation.
 *
 * CURRENCY COMES FROM THE DATA, NOT THE LOCALE. A British company holding euro
 * invoices must see euros. Formatting them as pounds because the reader is in
 * London is not a display bug, it is a wrong number.
 */

const DEFAULT_LOCALE = 'en-GB';

export function money(minorUnits: number, currency: string, locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

/**
 * A figure shortened for a chart axis or a headline.
 *
 * IT LOSES PRECISION AND IS THEREFORE NEVER USED FOR A FIGURE SOMEBODY ACTS ON.
 * `£184k` is right for an axis label and wrong on an invoice, and the difference
 * is not visible once it is rendered — so the exact form stays available beside
 * it wherever this is used.
 */
export function compactMoney(minorUnits: number, currency: string, locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(minorUnits / 100);
}

export function number(value: number, locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function percent(fraction: number, locale = DEFAULT_LOCALE, digits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

/** `14 Aug 2026`. Unambiguous: the month is named, so no reader has to guess. */
export function date(value: Date | string, locale = DEFAULT_LOCALE, timeZone = 'UTC'): string {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(d);
}

export function dateTime(value: Date | string, locale = DEFAULT_LOCALE, timeZone = 'UTC'): string {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(d);
}

/**
 * `9 days ago`.
 *
 * ABSOLUTE BEYOND A WEEK. "3 months ago" is friendly and useless when somebody is
 * reconciling a ledger; past a week the actual date is what is wanted.
 */
export function relativeTime(value: Date | string, now = new Date(), locale = DEFAULT_LOCALE): string {
  const d = value instanceof Date ? value : new Date(value);
  const seconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute > 7 * 86_400) return date(d, locale);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  for (const [unit, size] of units) {
    if (absolute >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

/** `1.2s`, `340ms`. For telemetry, where the unit matters more than precision. */
export function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit === 0 ? size : size.toFixed(1)}${units[unit]}`;
}
