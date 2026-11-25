import type { Exclusion, SetValue } from './resolve.mutation';
import type { PriorState, RecordChange, Target } from './preview.mutation';
import type { Receipt } from './receipt.mutation';
import { holds, identityOf } from './execute.mutation';
import { normalised } from './preview.mutation';
import { at, type Row } from '../detectors/shared.detector';

/**
 * Mutations §13 — revert, three-way, at the time of asking.
 *
 * ── The three states ───────────────────────────────────────────────────────
 *
 * BEFORE is what the receipt says the field held before the change. AFTER is
 * what the source held when the change was read back — not what was intended,
 * because a source that truncated the value left the truncation, and that is
 * what a later reader saw. NOW is what it holds as the revert is asked for.
 *
 *   now = after    nobody has touched it: revert it, cleanly.
 *   now = before   it is already back: nothing to do.
 *   anything else  somebody changed it since: a conflict, for a person to decide.
 *
 * ── Partial revert is first-class ──────────────────────────────────────────
 *
 * "A bulk mutation where forty records are unchanged and two have moved reverts
 * the forty and reports the two." Conflicts are decided per field, and a field
 * nobody has decided on is left alone — named, never silently overwritten and
 * never a reason to block the rest.
 */

export type Conflict = {
  connectionId: string;
  ref: string;
  field: string;
  column: string;
  before: unknown;
  after: unknown;
  now: unknown;
};

export type ConflictChoice = {
  connectionId: string;
  ref: string;
  field: string;
  /** Put the value back anyway, or leave what is there now. */
  choice: 'revert' | 'keep';
};

export type ThreeWay = {
  changes: RecordChange[];
  targets: Target[];
  /** What each record holds now, which is the revert's own prior state. */
  priorStates: PriorState[];
  conflicts: Conflict[];
  excluded: Exclusion[];
  /** Fields already holding what they held before the change. */
  unchanged: number;
  /** Conflicts somebody decided to leave as they are. */
  kept: number;
};

/** A separator no identifier or field name carries, built rather than typed. */
const SEP = String.fromCharCode(0);

export function threeWay(input: {
  receipt: Receipt;
  /** Per connection, every record read now, keyed by identity. */
  current: ReadonlyMap<string, ReadonlyMap<string, Row>>;
  choices: readonly ConflictChoice[];
}): ThreeWay {
  const { receipt } = input;
  const recordKey = (connectionId: string, ref: string) => [connectionId, ref].join(SEP);
  const fieldKey = (connectionId: string, ref: string, field: string) => [connectionId, ref, field].join(SEP);

  const before = new Map(receipt.priorStates.map((one) => [fieldKey(one.connectionId, one.ref, one.field), one.value]));
  const columnOf = new Map(
    receipt.diff.changes.flatMap((change) =>
      change.fields.map((field) => [fieldKey(change.connectionId, change.ref, field.field), field.column] as const),
    ),
  );
  const targetOf = new Map(receipt.entitySet.map((target) => [recordKey(target.connectionId, target.ref), target]));
  const choiceOf = new Map(input.choices.map((one) => [fieldKey(one.connectionId, one.ref, one.field), one.choice]));

  /* What the change actually left: fields that took the write, as they were read back. */
  const applied = new Map<string, Array<{ field: string; after: unknown }>>();
  for (const one of receipt.verifications) {
    if (one.field === null || one.outcome === 'failed') continue;
    const record = recordKey(one.connectionId, one.ref);
    applied.set(record, [...(applied.get(record) ?? []), { field: one.field, after: one.observed ?? null }]);
  }

  const result: ThreeWay = { changes: [], targets: [], priorStates: [], conflicts: [], excluded: [], unchanged: 0, kept: 0 };
  const excludedOnce = new Set<string>();
  const exclude = (one: Exclusion) => {
    const id = [one.connectionId, one.ref, one.reason].join(SEP);
    if (excludedOnce.has(id)) return;
    excludedOnce.add(id);
    result.excluded.push(one);
  };

  for (const [record, fields] of applied) {
    const target = targetOf.get(record);
    if (!target) continue;

    const identifier = Object.keys(target.identifier);
    const row = input.current.get(target.connectionId)?.get(identityOf(target.identifier, identifier)) ?? null;

    if (row === null) {
      exclude({ connectionId: target.connectionId, ref: target.ref, reason: 'record_missing' });
      continue;
    }

    const writing: RecordChange['fields'] = [];

    for (const { field, after } of fields) {
      const key = fieldKey(target.connectionId, target.ref, field);
      const column = columnOf.get(key);
      if (!column) continue;

      const was = before.get(key) ?? null;
      const now = normalised(at(row, column));

      if (holds(now, was)) {
        result.unchanged += 1;
        continue;
      }

      if (!holds(now, after)) {
        result.conflicts.push({ connectionId: target.connectionId, ref: target.ref, field, column, before: was, after, now });

        const choice = choiceOf.get(key);
        if (choice === 'keep') {
          result.kept += 1;
          continue;
        }
        if (choice !== 'revert') {
          exclude({ connectionId: target.connectionId, ref: target.ref, reason: 'conflicted' });
          continue;
        }
      }

      writing.push({ field, column, prior: now, proposed: was as SetValue });
    }

    if (writing.length === 0) continue;

    result.changes.push({ entity: target.entity, connectionId: target.connectionId, ref: target.ref, fields: writing });
    result.targets.push({ ...target, fields: writing.map((one) => one.field) });
    for (const one of writing) {
      result.priorStates.push({
        connectionId: target.connectionId,
        ref: target.ref,
        field: one.field,
        column: one.column,
        value: one.prior,
      });
    }
  }

  return result;
}
