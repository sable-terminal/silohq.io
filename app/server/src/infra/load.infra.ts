// Load shedding (spec 12.4): "Shedding order, first shed to last: recognition runs, index
// rebuilds, simulations, export rendering, new subscriptions, new compiles, saved view runs,
// Crons, Action execution, session authentication. Approvals, revert and audit are never shed.
// A shed request gets a capacity refusal with a retry time, never partial data."
//
// Each process measures its own load as the event loop's delay (the 99th percentile over each
// second): a process that cannot keep up answers everything late. Only sustained load sheds: the
// level is the lowest of the last three seconds', so one pause (a collection, a burst) sheds
// nothing. From SHED_START_MS each
// further SHED_STEP_MS sheds the next class in the order, the lowest first; below it nothing is
// shed. A contract names its class (endpoint.contract.ts `shed`); one that names none is never
// shed, so approvals, revert and audit never are. Background work asks the same gauge before
// starting (a Cron shed is a missed run, not backfilled). One gauge per process, started on
// first use; a test may hold its level.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { SHED_ORDER, type ShedClass } from '../contracts/endpoint.contract.ts';

export interface LoadGauge {
  /** How many classes are shed now, from the start of SHED_ORDER: 0 sheds nothing. */
  level(): number;
  /** Whether work of this class is refused now. */
  sheds(work: ShedClass): boolean;
  /** The event loop's delay at the last sample, in milliseconds (p99). */
  delayMs(): number;
}

export interface LoadSettings { startMs: number; stepMs: number; sampleMs?: number }

/** How many samples in a row a level must hold before it sheds. */
const SUSTAINED = 3;

/** The level the last samples hold together: the lowest of the last three, none until there are three. */
export function sustainedLevel(recent: readonly number[]): number {
  return recent.length < SUSTAINED ? 0 : Math.min(...recent.slice(-SUSTAINED));
}

/** The shed level for a delay: none below the start, then one more class each step. */
export function shedLevel(delayMs: number, settings: LoadSettings): number {
  if (delayMs < settings.startMs) return 0;
  return Math.min(SHED_ORDER.length, 1 + Math.floor((delayMs - settings.startMs) / Math.max(1, settings.stepMs)));
}

/** settings: read at each sample, so a process configured after its gauge started still sheds by its own thresholds. */
export function createLoadGauge(settings: () => LoadSettings): LoadGauge & { stop(): void } {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let delay = 0;
  let current = 0;
  const recent: number[] = [];
  const timer = setInterval(() => {
    delay = histogram.count === 0 ? 0 : histogram.percentile(99) / 1e6;
    histogram.reset();
    recent.push(shedLevel(delay, settings()));
    if (recent.length > SUSTAINED) recent.shift();
    current = sustainedLevel(recent);
  }, settings().sampleMs ?? 1_000);
  timer.unref();
  return {
    level: () => held ?? current,
    sheds: (work) => SHED_ORDER.indexOf(work) < (held ?? current),
    delayMs: () => delay,
    stop() { clearInterval(timer); histogram.disable(); },
  };
}

let gauge: (LoadGauge & { stop(): void }) | undefined;
let held: number | undefined;
let configured: LoadSettings = { startMs: 200, stepMs: 50 };

/** This process's gauge; the process's HTTP settings configure its thresholds (SHED_START_MS, SHED_STEP_MS). */
export function processLoad(settings?: LoadSettings): LoadGauge {
  if (settings !== undefined) configured = settings;
  gauge ??= createLoadGauge(() => configured);
  return gauge;
}

/** Tests: hold the shed level (undefined lets it follow the measured load again). */
export function holdShedLevel(level: number | undefined): void {
  held = level;
}
