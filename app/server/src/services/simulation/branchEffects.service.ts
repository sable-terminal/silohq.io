// Scenario branches (spec 39.8), the pure part: the three-way staleness check of revert
// (chapter 46) over a staged Action's bases, and what a staged Action does in the branch,
// as the walk's origins. No I/O.
//
// Staleness, per touched property of each target, comparing the value now, the branch base
// (read at staging) and the staged value:
//   now equals staged   already applied: nothing to change (so is a property the Action leaves as it was)
//   now equals base     clean: applies as staged
//   otherwise           conflicted: the person keeps staged, takes current, or re-stages
// and a target whose record no longer exists is orphaned, excluded from promotion with a
// statement. A target is conflicted while any conflicted property has no decision, already
// applied when every property is, clean otherwise; a staged Action likewise over its
// targets that still exist. A delete's base is the record's existence; a create has nothing
// to compare and is clean; a custom action's effect is known only once it runs, so its
// target is never already applied.
//
// Effect: a staged Action's effect is applied to its targets, and what follows is walked
// over the confirmed graph by the rules of 39.4 and 39.5. The walk propagates failure and
// delay, so an effect seeds it in those terms:
//   delete                              the target is unavailable
//   a date or instant moved later       the target is delayed by the largest such move
//   anything else                       nothing propagates, and the branch says why
// A property the person decided to take as current has no effect.

import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import type { Origin } from './propagation.service.ts';

export type Staleness = 'clean' | 'conflicted' | 'already_applied' | 'orphaned';
export type PropertyState = 'clean' | 'conflicted' | 'already_applied';
export type Resolution = 'keep_staged' | 'take_current';
export type StagedOperation = 'create' | 'update_full' | 'update_partial' | 'delete' | 'upsert' | 'custom';

/** A delete's one base: whether the record exists. */
export const RECORD_EXISTS = '@record';

export interface BaseEntry {
  /** The ontology property, or the source field where no property maps it (a link's key, a custom action's change). */
  property: string;
  field: string;
  base: unknown;
  staged: unknown;
}

export interface StagedTarget {
  objectId: string;
  connectionId: string;
  reference: string;
  operation: StagedOperation;
  entries: BaseEntry[];
}

export interface PropertyCheck extends BaseEntry {
  current: unknown;
  state: PropertyState;
  resolution: Resolution | null;
}

export interface TargetCheck {
  objectId: string;
  connectionId: string;
  reference: string;
  operation: StagedOperation;
  staleness: Staleness;
  properties: PropertyCheck[];
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * One target against its record now: `current` holds the touched fields by name, or is null
 * when the record no longer exists. `resolutions` are the person's decisions, by property.
 */
export function checkTarget(target: StagedTarget, current: Record<string, unknown> | null, resolutions: ReadonlyMap<string, Resolution>): TargetCheck {
  const base = { objectId: target.objectId, connectionId: target.connectionId, reference: target.reference, operation: target.operation };
  if (target.operation === 'create') {
    return { ...base, staleness: 'clean', properties: target.entries.map((e) => ({ ...e, current: null, state: 'clean', resolution: null })) };
  }
  if (current === null) {
    return { ...base, staleness: 'orphaned', properties: target.entries.map((e) => ({ ...e, current: null, state: 'clean', resolution: null })) };
  }
  const now = (e: BaseEntry): unknown => (e.property === RECORD_EXISTS ? true : current[e.field] ?? null);
  const properties: PropertyCheck[] = target.entries.map((e) => {
    const value = now(e);
    const state: PropertyState = target.operation !== 'custom' && same(value, e.staged) ? 'already_applied'
      : same(value, e.base) ? 'clean' : 'conflicted';
    return { ...e, current: value, state, resolution: state === 'conflicted' ? resolutions.get(e.property) ?? null : null };
  });
  const staleness: Staleness = properties.some((p) => p.state === 'conflicted' && p.resolution === null) ? 'conflicted'
    : properties.length > 0 && properties.every((p) => p.state === 'already_applied') ? 'already_applied' : 'clean';
  return { ...base, staleness, properties };
}

/** A staged Action over its targets: orphaned when none still exists. */
export function actionStaleness(targets: readonly TargetCheck[]): Staleness {
  const live = targets.filter((t) => t.staleness !== 'orphaned');
  if (live.length === 0) return 'orphaned';
  if (live.some((t) => t.staleness === 'conflicted')) return 'conflicted';
  if (live.every((t) => t.staleness === 'already_applied')) return 'already_applied';
  return 'clean';
}

export type Effect = { origin: Origin; reason: null } | { origin: null; reason: string };

const instant = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * What a checked target does in the branch. `timeProperties` names the type's date and
 * instant properties; the value now is the one moved from.
 */
export function effectOf(objectTypeId: string, target: TargetCheck, timeProperties: ReadonlySet<string>): Effect {
  if (target.staleness === 'orphaned') return { origin: null, reason: 'the record no longer exists' };
  if (target.operation === 'delete') return { origin: { objectTypeId, objectId: target.objectId, delaySeconds: null }, reason: null };
  if (target.operation === 'create') return { origin: null, reason: 'a record the branch creates has no links to walk yet' };
  if (target.operation === 'custom') return { origin: null, reason: 'a custom action\'s effect is known only once it runs' };
  let delay = 0;
  for (const p of target.properties) {
    if (!timeProperties.has(p.property) || p.resolution === 'take_current' || p.state === 'already_applied') continue;
    const [from, to] = [instant(p.current), instant(p.staged)];
    if (from !== undefined && to !== undefined && to > from) delay = Math.max(delay, (to - from) / 1000);
  }
  return delay > 0
    ? { origin: { objectTypeId, objectId: target.objectId, delaySeconds: delay }, reason: null }
    : { origin: null, reason: 'the change moves no date later and removes no record' };
}
