import type { Manifest, ManifestObject } from '../../schemas/manifest.schema';
import { capabilitiesOf, tableOf } from '../read/capabilities.read';
import type { Comparison, Query } from '../execution/query.execution';
import type { RecordChange } from './preview.mutation';
import type { MutationOperation, SetValue } from './resolve.mutation';
import { at, type Row } from '../detectors/shared.detector';

/**
 * Mutations §7 — what else the change touches.
 *
 * ── Walked before the plan is shown ────────────────────────────────────────
 *
 * "Foreign keys are walked before the plan is shown. The preview states what
 * else the change touches: dependent records, cascading deletes, relationships
 * that would break." An approver who sees forty invoices being deleted and not
 * the nine hundred payment rows the database removes with them has approved a
 * different change from the one that runs.
 *
 * ── Two sources of foreign keys, and why both ──────────────────────────────
 *
 * THE MANIFEST SAYS WHICH RELATIONSHIPS EXIST; ONLY THE DATABASE SAYS WHAT
 * HAPPENS TO THEM. A relationship in a manifest has no delete rule, and the
 * difference between CASCADE and RESTRICT is the difference between "these go
 * too" and "the source will refuse". So a SQL source's own catalogue is read for
 * the rules — and for foreign keys from tables the connector does not describe,
 * which cannot be counted and are named anyway, because an uncountable cascade
 * is still a cascade.
 *
 * WHERE NEITHER SAYS, THE PREVIEW SAYS IT DOES NOT KNOW. A REST API with a
 * declared relationship and no rule gets `left_dangling`, the effect that is
 * true whatever the source actually does, rather than the one that is most
 * reassuring.
 */

export type ReferentialAction = 'cascade' | 'restrict' | 'no_action' | 'set_null' | 'set_default';

export type ForeignKey = {
  /** The object holding the reference — the manifest's name where it describes one. */
  fromObject: string;
  fromField: string;
  toObject: string;
  toField: string;
  /** Whether the connector describes `fromObject`, and so whether it can be counted. */
  described: boolean;
  /** Null where the system did not say. */
  onDelete: ReferentialAction | null;
  onUpdate: ReferentialAction | null;
};

/** A foreign key as a database catalogue states it, in table terms. */
export type CatalogueKey = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
};

export type Effect =
  /** Removed by the source along with the record (ON DELETE CASCADE). */
  | 'deleted_with_it'
  /** The source refuses the change while these exist (RESTRICT, NO ACTION). */
  | 'blocks'
  /** The reference is cleared by the source (SET NULL, SET DEFAULT). */
  | 'unlinked'
  /** Nothing said what happens, so they are left pointing at what is gone. */
  | 'left_dangling'
  /** The source carries the new value into them (ON UPDATE CASCADE). */
  | 'follows'
  /** The change sets a reference to a value no record holds. */
  | 'points_nowhere';

export type Uncounted =
  /** The referencing table is not one the connector describes. */
  | 'not_described'
  /** The source cannot be asked by a list of values, or by equality. */
  | 'cannot_ask'
  /** Counting would take more requests of the source than a preview may make. */
  | 'too_many_requests';

export type Consequence = {
  connectionId: string;
  /** The object whose records are affected. */
  object: string;
  field: string;
  /** The field of the changed object the relationship runs through. */
  via: { object: string; field: string };
  effect: Effect;
  /** Null when it could not be counted, with `uncounted` saying why. */
  records: number | null;
  /** The count filled a page, so it is a floor rather than a total. */
  atLeast: boolean;
  uncounted?: Uncounted;
};

/** A count to be taken of the source, and the consequence it will describe. */
export type Question = {
  consequence: Omit<Consequence, 'records' | 'atLeast' | 'uncounted'>;
  /** Batches, each one request. */
  queries: Query[];
  /** What to count distinct records by. */
  identifier: string[];
  /** Records of the same object that are themselves being changed, not dependents. */
  exclude: Set<string>;
};

/**
 * Every foreign key touching this system, with rules where the source gave them.
 */
export function foreignKeysOf(manifest: Manifest, catalogue: readonly CatalogueKey[] | null): ForeignKey[] {
  const byTable = new Map(manifest.objects.map((object) => [tableOf(object) ?? object.name, object.name]));

  const keys: ForeignKey[] = manifest.objects.flatMap((object) =>
    object.relationships.map((relationship) => ({
      fromObject: object.name,
      fromField: relationship.field,
      toObject: relationship.targetObject,
      toField: relationship.targetField,
      described: true,
      onDelete: null,
      onUpdate: null,
    })),
  );

  for (const entry of catalogue ?? []) {
    const fromObject = byTable.get(entry.fromTable);
    const toObject = byTable.get(entry.toTable) ?? entry.toTable;

    const declared = keys.find(
      (key) =>
        key.fromObject === (fromObject ?? entry.fromTable) &&
        key.fromField === entry.fromColumn &&
        key.toObject === toObject &&
        key.toField === entry.toColumn,
    );

    if (declared) {
      declared.onDelete = entry.onDelete;
      declared.onUpdate = entry.onUpdate;
      continue;
    }

    keys.push({
      fromObject: fromObject ?? entry.fromTable,
      fromField: entry.fromColumn,
      toObject,
      toField: entry.toColumn,
      described: Boolean(fromObject),
      onDelete: entry.onDelete,
      onUpdate: entry.onUpdate,
    });
  }

  return keys;
}

function effectOf(operation: 'delete' | 'update', rule: ReferentialAction | null): Effect {
  switch (rule) {
    case 'cascade':
      return operation === 'delete' ? 'deleted_with_it' : 'follows';
    case 'restrict':
    case 'no_action':
      return 'blocks';
    case 'set_null':
    case 'set_default':
      return 'unlinked';
    case null:
      return 'left_dangling';
  }
}

/**
 * The questions a preview must ask one system before it can be shown.
 *
 * DEPENDENTS ARE COUNTED BY THE VALUES BEING REMOVED OR REPLACED. A delete asks
 * who references the deleted records' key; an update of a referenced field asks
 * who references its OLD value, since those are the rows the change strands.
 * An update of a referencing field asks the other way: does anything hold the
 * NEW value at all.
 */
export function planBlastRadius(input: {
  operation: MutationOperation;
  connectionId: string;
  manifest: Manifest;
  /** The object this connection's part of the concept lives in. */
  object: ManifestObject;
  keys: readonly ForeignKey[];
  changes: readonly RecordChange[];
  /** The targeted records' rows, for key values that are not concept fields. */
  rows: readonly Row[];
  set: Readonly<Record<string, SetValue>>;
  fieldMap: Readonly<Record<string, string>>;
  maxRows: number;
}): { questions: Question[]; settled: Consequence[] } {
  const capabilities = capabilitiesOf(input.manifest, input.object.name);
  const filters = new Set<Comparison>(capabilities.filters);
  const batch = capabilities.maxFilterValues || Number.POSITIVE_INFINITY;
  const described = new Map(input.manifest.objects.map((object) => [object.name, object]));
  const mine = input.changes.filter((change) => change.connectionId === input.connectionId);
  const targeted = new Set(mine.map((change) => change.ref));

  const questions: Question[] = [];
  const settled: Consequence[] = [];

  const ask = (
    consequence: Question['consequence'],
    over: { object: string; field: string; op: 'in' | 'eq'; values: unknown[] },
  ) => {
    const dependent = described.get(over.object);

    if (!dependent) {
      settled.push({ ...consequence, records: null, atLeast: false, uncounted: 'not_described' });
      return;
    }
    if (!filters.has(over.op)) {
      settled.push({ ...consequence, records: null, atLeast: false, uncounted: 'cannot_ask' });
      return;
    }

    const values = [...new Set(over.values.filter((value) => value !== null && value !== undefined))];
    if (values.length === 0) return;

    const query = (filterValue: unknown): Query => ({
      object: dependent.name,
      filters: [{ field: over.field, op: over.op, value: filterValue }],
      sort: [],
      fields: [...dependent.identifier],
      limit: input.maxRows,
    });

    const queries: Query[] = [];
    if (over.op === 'eq') {
      queries.push(query(values[0]));
    } else {
      for (let start = 0; start < values.length; start += batch) {
        queries.push(query(values.slice(start, start + batch)));
      }
    }

    questions.push({
      consequence,
      queries,
      identifier: [...dependent.identifier],
      exclude: over.object === input.object.name ? targeted : new Set(),
    });
  };

  if (input.operation === 'delete') {
    for (const key of input.keys.filter((one) => one.toObject === input.object.name)) {
      ask(
        {
          connectionId: input.connectionId,
          object: key.fromObject,
          field: key.fromField,
          via: { object: key.toObject, field: key.toField },
          effect: effectOf('delete', key.onDelete),
        },
        {
          object: key.fromObject,
          field: key.fromField,
          op: 'in',
          values: input.rows.map((row) => at(row, key.toField)),
        },
      );
    }

    return { questions, settled };
  }

  const changedColumns = new Map<string, unknown[]>();
  for (const change of mine) {
    for (const field of change.fields) {
      changedColumns.set(field.column, [...(changedColumns.get(field.column) ?? []), field.prior]);
    }
  }

  for (const [column, priors] of changedColumns) {
    for (const key of input.keys.filter((one) => one.toObject === input.object.name && one.toField === column)) {
      ask(
        {
          connectionId: input.connectionId,
          object: key.fromObject,
          field: key.fromField,
          via: { object: key.toObject, field: key.toField },
          effect: effectOf('update', key.onUpdate),
        },
        { object: key.fromObject, field: key.fromField, op: 'in', values: priors },
      );
    }

    const conceptField = Object.entries(input.fieldMap).find(([, mapped]) => mapped === column)?.[0];
    const proposed = conceptField === undefined ? null : input.set[conceptField];

    for (const key of input.keys.filter((one) => one.fromObject === input.object.name && one.fromField === column)) {
      if (proposed === null || proposed === undefined) continue;

      ask(
        {
          connectionId: input.connectionId,
          object: key.toObject,
          field: key.toField,
          via: { object: key.fromObject, field: key.fromField },
          effect: 'points_nowhere',
        },
        { object: key.toObject, field: key.toField, op: 'eq', values: [proposed] },
      );
    }
  }

  return { questions, settled };
}

/**
 * What the answers to a question add up to.
 *
 * DISTINCT RECORDS, NOT ROWS RETURNED. A dependent referencing two of the
 * deleted records comes back in two batches and is one record.
 *
 * `points_nowhere` IS A CONSEQUENCE ONLY WHEN NOTHING CAME BACK. A reference to
 * a value some record holds is an ordinary update.
 */
export function consequenceOf(question: Question, answers: ReadonlyArray<readonly Row[]>): Consequence | null {
  const seen = new Set<string>();
  let atLeast = false;

  question.queries.forEach((query, index) => {
    const rows = answers[index] ?? [];
    if (rows.length >= query.limit) atLeast = true;

    for (const row of rows) {
      const ref = question.identifier.map((field) => String(at(row, field) ?? '')).join('\u0000');
      if (!question.exclude.has(ref)) seen.add(ref);
    }
  });

  if (question.consequence.effect === 'points_nowhere') {
    return seen.size === 0 ? { ...question.consequence, records: 0, atLeast: false } : null;
  }

  return seen.size === 0 ? null : { ...question.consequence, records: seen.size, atLeast };
}

/** A consequence the preview could not count within its request budget. */
export function unaskable(question: Question): Consequence {
  return { ...question.consequence, records: null, atLeast: false, uncounted: 'too_many_requests' };
}
