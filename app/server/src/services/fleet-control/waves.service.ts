// Waves and health gates (spec 11.2), as pure functions over the cell registry and a
// rollout, so the rules can be read and tested on their own.
//
// stable: wave 0 the internal test cells (4 hours), wave 1 the canary cells (48 hours),
// then the shared commercial cells of the US, the EU and the UK (24 hours each). Wave 5,
// the dedicated cells, follows once these pass, each cell in a rollout of its own started
// in its customer's window (changeWindows.service.ts), so one customer's freeze holds no
// one else's release. canary: the test cells, then the canary cells. dev: the test cells.
// sovereign: the sovereign cells. Agent channels have no cell waves: agents roll in their
// own waves inside each cell (spec 11.4). Self-managed installs take releases by pull or
// bundle, outside the waves.
//
// A wave passes when its soak has elapsed and every cell in it has reported a passing
// verdict for this release since the wave started; then the next wave starts. A failing
// verdict halts the rollout at once, and every cell goes back to the previous release. A
// cell still silent a grace period after the soak halts it too: "A missing health signal
// is a failure."

import { GATES, type RolloutView } from '../../contracts/fleet-control/rollout.contract.ts';
import type { Channel } from '../../contracts/fleet-control/release.contract.ts';
import type { Cell } from '../../models/directory/cell.model.ts';

export const SOAK_HOURS = { test: 4, canary: 48, region: 24, dedicated: 24, sovereign: 24 } as const;
const IN_SERVICE: readonly Cell['status'][] = ['active', 'closed_to_placement', 'draining'];

export interface WavePlan {
  /** Internal test cells with synthetic tenants (wave 0). */
  testCells: readonly string[];
  /** Canary cells holding Silo's own organisation and opted-in design partners (wave 1). */
  canaryCells: readonly string[];
}

export function planWaves(channel: Channel, cells: readonly Pick<Cell, 'id' | 'kind' | 'residency' | 'status'>[], plan: WavePlan)
  : { cells: string[]; soakHours: number }[] {
  const live = cells.filter((cell) => IN_SERVICE.includes(cell.status));
  const known = new Set(live.map((cell) => cell.id));
  const test = plan.testCells.filter((id) => known.has(id));
  const canary = plan.canaryCells.filter((id) => known.has(id) && !test.includes(id));
  const internal = new Set([...test, ...canary]);
  const shared = (residency: Cell['residency']): string[] => live
    .filter((cell) => cell.kind === 'commercial' && cell.residency === residency && !internal.has(cell.id))
    .map((cell) => cell.id).sort();
  const ofKind = (kind: Cell['kind']): string[] => live.filter((cell) => cell.kind === kind && !internal.has(cell.id))
    .map((cell) => cell.id).sort();

  const waves: { cells: string[]; soakHours: number }[] = [];
  if (channel === 'dev') waves.push({ cells: test, soakHours: 0 });
  if (channel === 'canary' || channel === 'stable') {
    waves.push({ cells: test, soakHours: SOAK_HOURS.test }, { cells: canary, soakHours: SOAK_HOURS.canary });
  }
  if (channel === 'stable') {
    waves.push(
      { cells: shared('us'), soakHours: SOAK_HOURS.region },
      { cells: shared('eu'), soakHours: SOAK_HOURS.region },
      { cells: shared('uk'), soakHours: SOAK_HOURS.region },
    );
  }
  if (channel === 'sovereign') waves.push({ cells: ofKind('sovereign'), soakHours: SOAK_HOURS.sovereign });
  return waves.filter((wave) => wave.cells.length > 0);
}

/** A verdict from gate results: every gate must be present and passing. */
export function verdictOf(gates: readonly { gate: string; passed: boolean }[]): { verdict: 'pass' | 'fail'; failedGates: string[] } {
  const failedGates = GATES.filter((gate) => {
    const results = gates.filter((g) => g.gate === gate);
    return results.length === 0 || results.some((g) => !g.passed);
  });
  return { verdict: failedGates.length === 0 ? 'pass' : 'fail', failedGates };
}

export type RolloutEvent = 'wave_started' | 'wave_passed' | 'rollout_completed' | 'rollout_gate_failed' | 'rollout_signal_missing';

export function haltRolloutState(rollout: RolloutView, reason: NonNullable<RolloutView['haltReason']>, at: string,
  haltedBy: string | null = null): void {
  rollout.status = 'halted';
  rollout.haltReason = reason;
  rollout.haltedBy = haltedBy;
  rollout.endedAt = at;
}

/** Each dedicated cell in service, for its own rollouts of stable (spec 11.2 wave 5). */
export const dedicatedCells = (cells: readonly Pick<Cell, 'id' | 'kind' | 'status'>[]): string[] =>
  cells.filter((cell) => cell.kind === 'dedicated' && IN_SERVICE.includes(cell.status)).map((cell) => cell.id).sort();

/**
 * Moves a running rollout on to where the clock and the verdicts put it. mayStart, when
 * given, holds a wave not yet started (a dedicated cell outside its window or in a freeze).
 */
export function advanceRollout(input: RolloutView, now: number, graceMinutes: number, mayStart?: () => boolean)
  : { rollout: RolloutView; events: RolloutEvent[] } {
  const rollout = structuredClone(input);
  const events: RolloutEvent[] = [];
  if (rollout.status !== 'running') return { rollout, events };
  const at = new Date(now).toISOString();
  for (;;) {
    const wave = rollout.waves.find((w) => w.passedAt === null);
    if (wave === undefined) {
      rollout.status = 'completed';
      rollout.endedAt = at;
      events.push('rollout_completed');
      break;
    }
    if (wave.startedAt === null) {
      if (mayStart !== undefined && !mayStart()) break;
      wave.startedAt = at;
      events.push('wave_started');
    }
    const started = Date.parse(wave.startedAt);
    const verdicts = wave.cells.map((id) => {
      const verdict = rollout.verdicts[id];
      return verdict !== undefined && verdict.releaseId === rollout.releaseId && Date.parse(verdict.reportedAt) >= started ? verdict : undefined;
    });
    if (verdicts.some((v) => v?.verdict === 'fail')) {
      haltRolloutState(rollout, 'gate_failed', at);
      events.push('rollout_gate_failed');
      break;
    }
    const soakEnds = started + wave.soakHours * 3_600_000;
    if (now < soakEnds) break;
    if (verdicts.every((v) => v?.verdict === 'pass')) {
      wave.passedAt = at;
      events.push('wave_passed');
      continue;
    }
    if (now >= soakEnds + graceMinutes * 60_000) {
      haltRolloutState(rollout, 'signal_missing', at);
      events.push('rollout_signal_missing');
    }
    break;
  }
  return { rollout, events };
}

/** The release a cell should run under this rollout. */
export function desiredFor(rollout: RolloutView, cellId: string)
  : { releaseId: string | null; reason: 'current' | 'wave_started' | 'wave_pending' | 'rolled_back' } {
  if (rollout.status === 'completed') return { releaseId: rollout.releaseId, reason: 'current' };
  if (rollout.status === 'halted' || rollout.status === 'superseded') return { releaseId: rollout.previousReleaseId, reason: 'rolled_back' };
  const wave = rollout.waves.find((w) => w.cells.includes(cellId));
  return wave?.startedAt != null
    ? { releaseId: rollout.releaseId, reason: 'wave_started' }
    : { releaseId: rollout.previousReleaseId, reason: 'wave_pending' };
}
