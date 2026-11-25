// Secret unwraps in the last five minutes, in this process (spec 13.2: pages fire on "unwrap
// anomalies"; D252). Every unwrap is recorded in iam.credential_unwraps; this counts them as they
// happen so the process can report a rate, which the page compares with the cell's usual. Counts
// only: which credential, organisation or caller is the ledger's to say.

const WINDOW_MS = 5 * 60_000;
const at: number[] = [];

/** One unwrap, now. */
export function noteUnwrap(now = Date.now()): void {
  at.push(now);
  while (at.length > 0 && at[0]! <= now - WINDOW_MS) at.shift();
  // Bounded: past this the gauge is already paging.
  if (at.length > 100_000) at.splice(0, at.length - 100_000);
}

/** Unwraps in the last five minutes. */
export function unwrapsLastFiveMinutes(now = Date.now()): number {
  while (at.length > 0 && at[0]! <= now - WINDOW_MS) at.shift();
  return at.length;
}
