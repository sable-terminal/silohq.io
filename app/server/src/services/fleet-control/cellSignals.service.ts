// The health signals a cell's Fleet agent gates its releases on (spec 11.2), and the gates as
// pure functions over them, so the rules can be read and tested on their own.
//
// Every process in the cell reports what it answered since it started under the release it
// runs (contracts/fleet-control/signals.contract.ts); the agent keeps the latest report of each
// for a day. A release is judged on the processes running it that reported within the last two
// minutes, the release before on those that ran it:
// - error_rate: at most 1% of their requests failed (5xx). No process reporting the release is
//   a failure: "A missing health signal is a failure."
// - latency: the 95th percentile of requests with no extended bound within 2.5 seconds, once
//   at least 20 were timed.
// - refusal_rate: refusals (4xx) no more than twice the release before's share, nor more than
//   two points above it, once both have answered enough (50 and 100 requests); with no release
//   before to compare, at most a quarter.
// - crash_loops: the release's pods (annotated silo.io/release) neither crash looping nor
//   failing to pull or start, nor restarted three times; none at all is a failure.
// - audit_outbox_backlog: the relay reports the oldest event waiting to be published at most
//   five minutes old; no relay reporting is a failure.
// The synthetic question, subscription, Action and revert tests are the other four gates.

import { LATENCY_BUCKETS_MS, type ProcessSignals } from '../../contracts/fleet-control/signals.contract.ts';

export interface GateSettings {
  /** How long a release runs before it is judged. */
  windowMs: number;
  errorRate: number;
  latencyP95Ms: number;
  outboxSeconds: number;
  /** A report older than this does not count. */
  freshMs: number;
}

export const DEFAULT_GATE_SETTINGS: Omit<GateSettings, 'windowMs'> = { errorRate: 0.01, latencyP95Ms: 2_500, outboxSeconds: 300, freshMs: 120_000 };

/** A pod as the gates read it. */
export interface PodView {
  metadata: { name: string; annotations?: Record<string, string> };
  status?: { containerStatuses?: { restartCount?: number; state?: { waiting?: { reason?: string } } }[] };
}

export type JudgedGate = { gate: 'error_rate' | 'latency' | 'refusal_rate' | 'crash_loops' | 'audit_outbox_backlog'; passed: boolean };

const KEPT_MS = 24 * 3_600_000;
const STUCK = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName']);

export function createSignalStore(now: () => number = Date.now) {
  const latest = new Map<string, { signals: ProcessSignals; receivedAt: number }>();
  const prune = (): void => {
    for (const [id, entry] of latest) if (now() - entry.receivedAt > KEPT_MS) latest.delete(id);
  };
  return {
    /** A process's report; an older one than that held is not taken. */
    receive(processId: string, signals: ProcessSignals): boolean {
      prune();
      const held = latest.get(processId);
      if (held !== undefined && Date.parse(held.signals.reportedAt) > Date.parse(signals.reportedAt)) return false;
      latest.set(processId, { signals, receivedAt: now() });
      return true;
    },
    /** The processes that ran a release; only those reporting lately when fresh. */
    on(release: string, freshMs?: number): ProcessSignals[] {
      return [...latest.values()].filter((e) => e.signals.release === release && (freshMs === undefined || now() - e.receivedAt <= freshMs)).map((e) => e.signals);
    },
    /** Every process that reported lately, by its id. */
    fresh(freshMs: number): { processId: string; signals: ProcessSignals }[] {
      return [...latest.entries()].filter(([, e]) => now() - e.receivedAt <= freshMs).map(([processId, e]) => ({ processId, signals: e.signals }));
    },
    /** A gauge from every process reporting it lately. */
    gauge(name: string, freshMs: number): number[] {
      return [...latest.values()].filter((e) => now() - e.receivedAt <= freshMs && e.signals.gauges[name] !== undefined).map((e) => e.signals.gauges[name]!);
    },
  };
}

export type SignalStore = ReturnType<typeof createSignalStore>;

const sum = (all: readonly ProcessSignals[], pick: (s: ProcessSignals) => number): number => all.reduce((n, s) => n + pick(s), 0);

/** The 95th percentile's bucket bound over the merged histograms, or undefined below 20 timed requests. */
export function p95(all: readonly ProcessSignals[]): number | undefined {
  const merged = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  for (const s of all) s.requests.latency.forEach((n, i) => { merged[i]! += n; });
  const timed = merged.reduce((a, b) => a + b, 0);
  if (timed < 20) return undefined;
  let seen = 0;
  for (let i = 0; i < merged.length; i++) {
    seen += merged[i]!;
    if (seen >= 0.95 * timed) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i]! : Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

export function judgeGates(input: {
  releaseId: string; current: readonly ProcessSignals[]; previous: readonly ProcessSignals[]; outboxOldest: readonly number[]; pods: readonly PodView[];
}, settings: Omit<GateSettings, 'windowMs'> = DEFAULT_GATE_SETTINGS): JudgedGate[] {
  const { current, previous } = input;
  const total = sum(current, (s) => s.requests.total);
  const errors = sum(current, (s) => s.requests.errors);
  const errorRate = current.length > 0 && (total === 0 || errors / total <= settings.errorRate);

  const latencyBound = p95(current);
  const latency = current.length > 0 && (latencyBound === undefined || latencyBound <= settings.latencyP95Ms);

  const refused = sum(current, (s) => s.requests.refused);
  const before = sum(previous, (s) => s.requests.total);
  const beforeShare = before === 0 ? 0 : sum(previous, (s) => s.requests.refused) / before;
  const share = total === 0 ? 0 : refused / total;
  const refusalRate = current.length > 0 && (total < 50 || (before >= 100
    ? share <= Math.max(2 * beforeShare, beforeShare + 0.02)
    : share <= 0.25));

  const pods = input.pods.filter((p) => p.metadata.annotations?.['silo.io/release'] === input.releaseId);
  const crashLoops = pods.length > 0 && pods.every((p) => (p.status?.containerStatuses ?? []).every((c) =>
    (c.restartCount ?? 0) < 3 && !STUCK.has(c.state?.waiting?.reason ?? '')));

  const outbox = input.outboxOldest.length > 0 && Math.max(...input.outboxOldest) <= settings.outboxSeconds;

  return [
    { gate: 'error_rate', passed: errorRate },
    { gate: 'latency', passed: latency },
    { gate: 'refusal_rate', passed: refusalRate },
    { gate: 'crash_loops', passed: crashLoops },
    { gate: 'audit_outbox_backlog', passed: outbox },
  ];
}
