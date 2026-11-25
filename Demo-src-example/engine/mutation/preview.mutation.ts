import { APPROVAL_CANARY_ROWS, APPROVAL_SECOND_APPROVER_ROWS } from '../../config/constants.config';
import { createHash } from 'node:crypto';
import type { ContributingObject } from '../../models/concept.model';
import type {
  Exclusion,
  MutationOperation,
  ResolutionPolicy,
  SetValue,
  TargetEntity,
} from './resolve.mutation';
import type { Consequence } from './blast.mutation';
import { at, type Row } from '../detectors/shared.detector';

/**
 * Mutations §6 and §8 — what every affected record held, and the diff.
 *
 * ── Computed once ──────────────────────────────────────────────────────────
 *
 * §8: "The diff is computed once and rendered identically everywhere it
 * appears." This is the only function that computes it. The console, the
 * approvals queue and the receipt read what it produced out of the table; none
 * of them has the inputs to compute it again, which is what makes "identically"
 * true rather than intended.
 */

/** One field of one record: what it holds, and what it would hold. */
export type FieldChange = {
  /** The concept's name for the field. */
  field: string;
  /** That system's name for it — lineage, not something the user typed. */
  column: string;
  prior: unknown;
  /** Absent for a delete, where the record goes rather than the value changing. */
  proposed?: SetValue;
};

/** §8 — one record's row in the diff. */
export type RecordChange = {
  entity: number;
  connectionId: string;
  ref: string;
  fields: FieldChange[];
};

/** §6 — what is stored before anything is written. */
export type PriorState = {
  connectionId: string;
  ref: string;
  field: string;
  column: string;
  value: unknown;
};

export type Target = {
  entity: number;
  connectionId: string;
  ref: string;
  /** Every field the system identifies the record by, and its value. */
  identifier: Record<string, unknown>;
  /** The concept fields written (update) or removed with the record (delete). */
  fields: string[];
};

/**
 * A value as it will be stored and compared.
 *
 * A DATE FROM A DRIVER IS AN OBJECT; THE SAME DATE IN JSON IS A STRING. Stored
 * as-is, the prior state of a timestamp column would come back from `jsonb` as a
 * string and never equal the object a later read produces, so every revert of a
 * dated field would report a conflict that is not there.
 */
export function normalised(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * The records, their prior state, and the diff.
 *
 * ── Only what changes ──────────────────────────────────────────────────────
 *
 * A FIELD ALREADY HOLDING THE NEW VALUE IS NOT PART OF THE CHANGE. It is not in
 * the diff, not stored, and not written; a record where every field already
 * holds it is not a target at all and is counted as `unchanged`. Otherwise a
 * change to four hundred records of which three hundred were already right
 * previews, approves and bulk-checks as four hundred.
 *
 * ── A delete stores the concept's fields, and still is not revertable ──────
 *
 * The approver of a delete needs to see what is going, so each record's concept
 * fields are read and shown. That is still not the whole record — its other
 * columns are never read — so a delete cannot be undone from it, and §13 says
 * so rather than attempting a partial recreation.
 */
export function diffOf(input: {
  operation: MutationOperation;
  set: Readonly<Record<string, SetValue>>;
  entities: readonly TargetEntity[];
  objects: readonly ContributingObject[];
  /** Per connection, every field the manifest identifies a record by. */
  identifiers: ReadonlyMap<string, readonly string[]>;
}): { changes: RecordChange[]; priorStates: PriorState[]; targets: Target[]; unchanged: number } {
  const objectOf = new Map(input.objects.map((object) => [object.connectionId, object]));

  const changes: RecordChange[] = [];
  const priorStates: PriorState[] = [];
  const targets: Target[] = [];
  let unchanged = 0;

  for (const entity of input.entities) {
    for (const member of entity.members) {
      const object = objectOf.get(member.connectionId)!;

      const fields: FieldChange[] =
        input.operation === 'update'
          ? Object.entries(input.set)
              .filter(([field]) => field in object.fieldMap)
              .map(([field, proposed]) => ({
                field,
                column: object.fieldMap[field]!,
                prior: normalised(at(member.row, object.fieldMap[field]!)),
                proposed,
              }))
              .filter((change) => !same(change.prior, change.proposed))
          : Object.entries(object.fieldMap)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([field, column]) => ({ field, column, prior: normalised(at(member.row, column)) }));

      if (input.operation === 'update' && fields.length === 0) {
        unchanged += 1;
        continue;
      }

      changes.push({ entity: entity.index, connectionId: member.connectionId, ref: member.ref, fields });

      for (const change of fields) {
        priorStates.push({
          connectionId: member.connectionId,
          ref: member.ref,
          field: change.field,
          column: change.column,
          value: change.prior,
        });
      }

      targets.push({
        entity: entity.index,
        connectionId: member.connectionId,
        ref: member.ref,
        identifier: Object.fromEntries(
          (input.identifiers.get(member.connectionId) ?? []).map((field) => [
            field,
            normalised(at(member.row, field)),
          ]),
        ),
        fields: fields.map((change) => change.field),
      });
    }
  }

  return { changes, priorStates, targets, unchanged };
}

/**
 * Equal as a system would store it.
 *
 * A NUMBER READ AS TEXT IS STILL THE NUMBER. Plenty of drivers return `numeric`
 * as a string to keep its precision, and treating `"100.00"` and `100` as a
 * change would write a record that does not need writing and preview it as
 * though it did.
 */
export function same(prior: unknown, proposed: SetValue): boolean {
  if (prior === proposed) return true;
  if (prior === null || proposed === null) return false;
  if (typeof proposed === 'number' && typeof prior === 'string' && prior.trim() !== '') {
    return Number(prior) === proposed;
  }
  return false;
}

/**
 * §8 — the preview, as stored and as every surface shows it.
 *
 * NOT ATOMIC ACROSS CONNECTIONS, AND IT SAYS SO (§10). `atomic` is false
 * whenever records in more than one system change: two source systems share no
 * transaction, and a change that succeeds in two of three is a possible outcome
 * the approver is agreeing to.
 */
export type MutationPreview = {
  operation: MutationOperation;
  resolution: ResolutionPolicy;
  connections: Array<{
    connectionId: string;
    name: string;
    /** The system's object — lineage for the reviewer, not something the user named. */
    object: string;
    connectorVersion: number;
    records: number;
  }>;
  entities: number;
  /** Rows affected: records, not entities. What the bulk tier is decided on. */
  records: number;
  /** Records the entity set reached that already hold every new value. */
  unchanged: number;
  changes: RecordChange[];
  excluded: Exclusion[];
  /** Per written system, entities with no record there to change. */
  absent: Array<{ connectionId: string; entities: number }>;
  blastRadius: Consequence[];
  /**
   * §2.3 (131) — columns this change writes by a name Silo LEARNED, not one a
   * person confirmed or the system uses.
   *
   * SAID TO WHOEVER APPROVES IT. An answer shows one `city` across two systems
   * because their records agreed; a change to it lands in a column the system
   * itself calls `town`. That is what was asked for, and it is exactly the
   * step somebody approving a write should be shown rather than left to infer
   * — with the evidence the name rests on. Absent when there are none.
   */
  learned?: Array<{ connectionId: string; field: string; column: string; compared: number | null; agreed: number | null }>;
  bulk: BulkTier;
  atomic: boolean;
  /**
   * §13 — a delete cannot be reverted: the whole record is never read, so it
   * cannot be recreated. Said before approval, not discovered after.
   */
  revertable: boolean;
};

/* ── Bulk guardrails ───────────────────────────────────────────────────────── */

/** §8 — "Bulk guardrails, unchanged." */
/*
 * §6.3's tiers, read from the one place they are written down rather than
 * restated here. The engine may reach config — what it may not reach is a
 * repository or a database, so that the arithmetic stays runnable without one.
 */
const BULK = { additional: APPROVAL_SECOND_APPROVER_ROWS, canary: APPROVAL_CANARY_ROWS } as const;

export type BulkTier = 'standard' | 'additional' | 'canary';

/**
 * Rows affected, which is records and not entities. A customer held in three
 * systems is three writes, three chances to fail, and three rows to revert.
 */
export function bulkTier(records: number): BulkTier {
  if (records >= BULK.canary) return 'canary';
  if (records >= BULK.additional) return 'additional';
  return 'standard';
}

/* ── The digest ────────────────────────────────────────────────────────────── */

/**
 * SHA-256 of the preview, with keys in a fixed order.
 *
 * WHAT THE AUDIT TRAIL CARRIES INSTEAD OF THE VALUES (§15). A reviewer holding a
 * receipt can check it is the diff that was approved, without the trail itself
 * becoming a second copy of the customer's data that retention never reaches.
 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Row)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`;
}
