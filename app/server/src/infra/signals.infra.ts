// A process's health signals (spec 11.2; contracts/fleet-control/signals.contract.ts): what its
// service listener answered since it started, and the gauges its services keep, which the
// process reports to the cell's Fleet agent for its release gates. Counts only: never a path,
// a caller or anything a request carried.

import { LATENCY_BUCKETS_MS, type ProcessSignals } from '../contracts/fleet-control/signals.contract.ts';

export interface RequestSignals {
  /** One answered request: its status, how long it took, and whether its latency counts (no extended bound). */
  record(status: number, ms: number, timed: boolean): void;
  /** A gauge a service keeps, read when the process reports; undefined leaves it out. */
  gauge(name: string, read: () => Promise<number | undefined>): void;
  /** A log line a value pattern was redacted from, naming an organisation (13.1; D209). */
  redaction(organisationId: string, kinds: string[]): void;
  snapshot(): Promise<Pick<ProcessSignals, 'requests' | 'gauges' | 'redactions'>>;
}

export function createRequestSignals(): RequestSignals {
  const requests = { total: 0, refused: 0, errors: 0, latency: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0) };
  const gauges = new Map<string, () => Promise<number | undefined>>();
  const redactions = new Map<string, { count: number; kinds: Set<string> }>();
  return {
    redaction(organisationId, kinds) {
      const held = redactions.get(organisationId) ?? (redactions.size < 50 ? { count: 0, kinds: new Set<string>() } : undefined);
      if (held === undefined) return;
      held.count += 1;
      for (const k of kinds) if (held.kinds.size < 10 && /^[a-z_]{1,40}$/.test(k)) held.kinds.add(k);
      redactions.set(organisationId, held);
    },
    record(status, ms, timed) {
      requests.total += 1;
      if (status >= 500) requests.errors += 1;
      else if (status >= 400) requests.refused += 1;
      if (timed) {
        const bucket = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
        requests.latency[bucket === -1 ? LATENCY_BUCKETS_MS.length : bucket]! += 1;
      }
    },
    gauge(name, read) {
      gauges.set(name, read);
    },
    async snapshot() {
      const read: Record<string, number> = {};
      for (const [name, value] of gauges) {
        const v = await value().catch(() => undefined);
        if (v !== undefined && Number.isFinite(v)) read[name] = v;
      }
      return {
        requests: { ...requests, latency: [...requests.latency] }, gauges: read,
        ...(redactions.size === 0 ? {} : { redactions: [...redactions].map(([organisationId, r]) => ({ organisationId, count: r.count, kinds: [...r.kinds].sort() })) }),
      };
    },
  };
}

/**
 * Keys without a TTL in a Redis instance, for the page on them (spec 8.3, 13.2; D252): the
 * instance's key audit (SCAN, never KEYS, at most scanLimit keys), run at most every ten minutes,
 * its last count reported as the gauge between runs.
 */
export function keysWithoutTtlGauge(audit: () => Promise<{ withoutTtl: number }>, everyMs = 10 * 60_000): () => Promise<number | undefined> {
  let last: number | undefined;
  let at = 0;
  let running: Promise<void> | undefined;
  return async () => {
    if (Date.now() - at >= everyMs && running === undefined) {
      at = Date.now();
      running = audit().then((r) => { last = r.withoutTtl; }, () => undefined).finally(() => { running = undefined; });
      await running;
    }
    return last;
  };
}
