// How the client writes times, numbers and sizes: British English, the person's own time zone,
// never a raw ISO string or an unrounded float in front of a person.

const LOCALE = 'en-GB';

const dateTime = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const timeOnly = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const number = new Intl.NumberFormat(LOCALE);

const parse = (value: string | number | Date): Date | undefined => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** 24 Nov 2026, 14:03 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = parse(value);
  return date === undefined ? String(value) : dateTime.format(date);
}

/** 24 Nov 2026 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = parse(value);
  return date === undefined ? String(value) : dateOnly.format(date);
}

/** 14:03 */
export function formatTime(value: string | number | Date): string {
  const date = parse(value);
  return date === undefined ? String(value) : timeOnly.format(date);
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.345], ['month', 12], ['year', Number.POSITIVE_INFINITY],
];

/** "5 minutes ago", "in 2 hours", "yesterday"; "just now" under ten seconds. */
export function formatRelative(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined) return '—';
  const date = parse(value);
  if (date === undefined) return String(value);
  let amount = (date.getTime() - now) / 1000;
  if (Math.abs(amount) < 10) return 'just now';
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit);
    amount /= size;
  }
  return dateOnly.format(date);
}

export function formatNumber(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return digits === undefined ? number.format(value) : new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(value);
}

/** 1.4 MB: binary multiples, written as people read them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${formatNumber(value)} ${value === 1 ? 'byte' : 'bytes'}` : `${formatNumber(value, value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** 2 h 5 min, 45 s, 120 ms. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

/** 1 connection, 3 connections; a plural that is not +s is given. */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** £1,234.50 from minor units. */
export function formatMoney(minor: number | null | undefined, currency = 'GBP'): string {
  if (minor === null || minor === undefined) return '—';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(minor / 100);
}

/** Sentence case for a machine word: "source_unreachable" → "Source unreachable". */
export function humanise(word: string): string {
  const spaced = word.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
