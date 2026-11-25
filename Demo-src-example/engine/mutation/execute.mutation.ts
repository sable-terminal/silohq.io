import type { Mutation } from '../write/run.write';
import type { MutationOperation } from './resolve.mutation';
import { normalised, same, type RecordChange, type Target } from './preview.mutation';
import { at, type Row } from '../detectors/shared.detector';

/**
 * Mutations §10–§11 — what to write, whether it may still be written, and what
 * the source holds afterwards.
 *
 * ── Checked before, and read back after ────────────────────────────────────
 *
 * AN APPROVAL IS OF A DIFF: this record goes from X to Y. A record that holds Z
 * by the time the change runs is not the record anybody approved changing, so it
 * is not written; it is reported as failed, with the reason. The preview window
 * makes this rare. It does not make it impossible, and writing Y over Z is the
 * one outcome nobody could have agreed to.
 *
 * A RECORD ALREADY HOLDING Y WAS WRITTEN BY AN EARLIER ATTEMPT. A run picked up
 * after an instance died meets its own work; it verifies that rather than
 * writing it again, which is what makes a run resumable record by record.
 */

export type Readiness =
  /** Every field still holds what the preview read. */
  | 'write'
  /** Every field already holds what the change sets. */
  | 'applied'
  /** A field holds something neither read nor intended. */
  | 'changed'
  /** The record is not there. */
  | 'missing';

/** Equal as a stored value compares to one the source returns now. */
export function holds(observed: unknown, expected: unknown): boolean {
  const now = normalised(observed);
  if (expected === null || ['string', 'number', 'boolean'].includes(typeof expected)) {
    return same(now, expected as string | number | boolean | null) || same(expected, now as string | number | boolean | null);
  }
  return JSON.stringify(now) === JSON.stringify(expected);
}

/** Whether a record may be written now. */
export function readiness(operation: MutationOperation, change: RecordChange, current: Row | null): Readiness {
  if (current === null) return operation === 'delete' ? 'applied' : 'missing';

  const fields = change.fields.map((field) => ({
    prior: holds(at(current, field.column), field.prior),
    proposed: operation === 'update' && holds(at(current, field.column), field.proposed ?? null),
  }));

  if (fields.some((field) => !field.prior && !field.proposed)) return 'changed';
  if (operation === 'update' && fields.length > 0 && fields.every((field) => field.proposed)) return 'applied';
  return 'write';
}

/** The engine's write for one record. */
export function writeFor(input: {
  operation: MutationOperation;
  object: string;
  change: RecordChange;
  target: Target;
}): Mutation {
  if (input.operation === 'delete') {
    return { object: input.object, kind: 'delete', identifier: input.target.identifier };
  }

  return {
    object: input.object,
    kind: 'update_partial',
    identifier: input.target.identifier,
    values: Object.fromEntries(input.change.fields.map((field) => [field.column, field.proposed ?? null])),
  };
}

export type Verification = {
  ref: string;
  /** Null for a delete: the outcome is the record's. */
  field: string | null;
  /** Absent for a delete, which intends no value. */
  intended?: unknown;
  /**
   * ABSENT WHEN NOTHING WAS READ, which is not the same as reading an empty
   * field. A write refused before it was made, or a record not there to read,
   * has no observed value; a field that came back empty has `null`.
   */
  observed?: unknown;
  outcome: 'verified' | 'diverged' | 'failed';
  detail: string | null;
};

/**
 * §11 — what the source holds, against what was intended.
 *
 * PER FIELD, because a source that truncates one field and stores another
 * faithfully has done two different things, and "diverged" for the record would
 * hide which. A field still holding what it held before did not take the write:
 * failed. One holding neither the old value nor the new one took something:
 * diverged, and never smoothed into verified.
 */
export function verify(input: {
  operation: MutationOperation;
  change: RecordChange;
  /** The record as read back, or null when it is not there. */
  observed: Row | null;
  /** Set when the write itself was refused or threw, with the code it gave. */
  writeError?: string | null;
}): Verification[] {
  const { change } = input;

  if (input.writeError) {
    return input.operation === 'delete'
      ? [{ ref: change.ref, field: null, outcome: 'failed', detail: input.writeError }]
      : change.fields.map((field) => ({
          ref: change.ref,
          field: field.field,
          intended: field.proposed ?? null,
          outcome: 'failed' as const,
          detail: input.writeError!,
        }));
  }

  if (input.operation === 'delete') {
    return [
      input.observed === null
        ? { ref: change.ref, field: null, outcome: 'verified', detail: null }
        : { ref: change.ref, field: null, outcome: 'failed', detail: 'upstream.write_not_applied' },
    ];
  }

  if (input.observed === null) {
    return change.fields.map((field) => ({
      ref: change.ref,
      field: field.field,
      intended: field.proposed ?? null,
      outcome: 'failed' as const,
      detail: 'upstream.record_missing_after_write',
    }));
  }

  return change.fields.map((field) => {
    const observed = normalised(at(input.observed!, field.column));
    const intended = field.proposed ?? null;

    if (holds(observed, intended)) {
      return { ref: change.ref, field: field.field, intended, observed, outcome: 'verified' as const, detail: null };
    }
    if (holds(observed, field.prior)) {
      return {
        ref: change.ref,
        field: field.field,
        intended,
        observed,
        outcome: 'failed' as const,
        detail: 'upstream.write_not_applied',
      };
    }
    return { ref: change.ref, field: field.field, intended, observed, outcome: 'diverged' as const, detail: null };
  });
}

/** A record the check refused to write, reported the way a failed write is. */
export function notWritten(change: RecordChange, operation: MutationOperation, reason: Readiness): Verification[] {
  const detail = reason === 'missing' ? 'refusal.record_missing' : 'refusal.changed_since_preview';
  return verify({ operation, change, observed: null, writeError: detail });
}

/** Whether a record's verification says the write reached the source. */
export function applied(verifications: readonly Verification[]): boolean {
  return verifications.some((one) => one.outcome !== 'failed');
}

/**
 * §8 — the canary: the records of the first hundred entities.
 *
 * WHOLE ENTITIES, NOT THE FIRST HUNDRED ROWS. A sample that updated a customer
 * in one system and left their counterpart for the remainder would create the
 * disagreement the canary is meant to catch as its first act.
 */
const CANARY_ENTITIES = 100;

export function canarySample<T extends { entity: number }>(records: readonly T[]): T[] {
  const entities = [...new Set(records.map((record) => record.entity))].sort((a, b) => a - b).slice(0, CANARY_ENTITIES);
  const chosen = new Set(entities);
  return records.filter((record) => chosen.has(record.entity));
}

export type ExecutionStatus = 'succeeded' | 'partial' | 'failed';

export function executionStatus(counts: { records: number; applied: number; failed: number }): ExecutionStatus {
  if (counts.failed === 0) return 'succeeded';
  return counts.applied > 0 ? 'partial' : 'failed';
}

/**
 * §10 — the change's outcome, from its systems' outcomes.
 *
 * NEVER ONE WORD FOR A SPLIT. Two systems written and one not is
 * `partially_executed`, and the receipt carries which.
 */
export function outcomeOf(
  executions: ReadonlyArray<{ status: ExecutionStatus | 'skipped' | 'running'; applied: number }>,
): 'executed' | 'partially_executed' | 'failed' {
  const applied = executions.reduce((sum, one) => sum + one.applied, 0);
  if (applied === 0) return 'failed';
  return executions.every((one) => one.status === 'succeeded') ? 'executed' : 'partially_executed';
}

/** A record's identifier as one comparable string. */
export function identityOf(identifier: Readonly<Record<string, unknown>>, fields: readonly string[]): string {
  return fields.map((field) => String(normalised(identifier[field]) ?? '')).join('\u0000');
}
