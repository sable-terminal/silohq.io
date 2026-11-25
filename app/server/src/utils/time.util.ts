// Time. Timestamps travel as ISO 8601 strings with microseconds, exactly as Postgres
// holds them (a JavaScript Date keeps only milliseconds; src/infra/postgres.infra.ts).

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

// One textual form per instant: UTC, six fractional digits, 'Z'. Two strings for the
// same instant (+00:00 or Z, .5 or .500000, any offset) canonicalise to the same text,
// so a hash over a timestamp does not depend on who formatted it.
export function canonicalTimestamp(value: string): string {
  const match = ISO.exec(value);
  if (!match) throw new TypeError('not an ISO 8601 timestamp');
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone!.startsWith('-') ? -1 : 1;
    const digits = zone!.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
    - offsetMinutes * 60_000;
  if (Number.isNaN(utcMs)) throw new TypeError('not a valid timestamp');
  const micro = fraction.padEnd(6, '0').slice(0, 6);
  return `${new Date(utcMs).toISOString().slice(0, 19)}.${micro}Z`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(isoOrDate: string | Date, seconds: number): string {
  const base = typeof isoOrDate === 'string' ? Date.parse(isoOrDate) : isoOrDate.getTime();
  return new Date(base + seconds * 1000).toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
