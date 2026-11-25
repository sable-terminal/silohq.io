// Field profiles (contracts/connect-runtime/profile.contract.ts, spec 22.3): one bounded read
// of the object, its values as the source sent them, counted here and dropped. Only counts
// leave this service.

import type { FieldProfileCounts } from '../../contracts/connect-runtime/profile.contract.ts';
import type { FieldType } from '../../contracts/connect/manifest.contract.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { coerce, type ReadStats } from './engine.service.ts';
import { readObject, type RuntimeDeps } from './read.service.ts';

interface Caller {
  request: RequestContext;
  correlationId: string;
  signal: AbortSignal;
}

/** The length of a value's text, or undefined for one that has no text form of its own. */
function lengthOf(value: unknown): number | undefined {
  if (typeof value === 'string') return [...value].length;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).length;
  return undefined;
}

/** Counts for one field over the rows examined. Distinct only when every row was examined. */
export function profileField(field: string, type: FieldType, values: readonly unknown[], complete: boolean): FieldProfileCounts {
  const scratch: ReadStats = { pages: 0, sourceRows: 0, typeMismatches: 0, retries: 0 };
  let nulls = 0;
  let empties = 0;
  let conforming = 0;
  let min: number | undefined;
  let max: number | undefined;
  const distinct = complete ? new Set<string>() : undefined;
  for (const value of values) {
    if (value === null || value === undefined) {
      nulls += 1;
      continue;
    }
    if (value === '') empties += 1;
    if (coerce(value, type, scratch) !== null) conforming += 1;
    const length = lengthOf(value);
    if (length !== undefined) {
      min = min === undefined ? length : Math.min(min, length);
      max = max === undefined ? length : Math.max(max, length);
    }
    distinct?.add(typeof value === 'object' ? JSON.stringify(value) : `${typeof value}:${String(value)}`);
  }
  return {
    field, rowCount: values.length, distinctCount: distinct === undefined ? null : distinct.size, nullCount: nulls, emptyCount: empties,
    minLength: min ?? null, maxLength: max ?? null, typeConformanceCount: conforming,
  };
}

export async function profileObject(deps: RuntimeDeps, caller: Caller, input: {
  connectionId: string; object: string; fields?: string[] | undefined; reason: 'query' | 'probe'; maxRows: number;
}) {
  // The extra row below must stay within the step's bound.
  const limit = Math.max(1, Math.min(input.maxRows, deps.bounds.maxRowsPerSourceStep - 1));
  const read = await readObject(deps, caller, {
    connectionId: input.connectionId, reason: input.reason, rawValues: true,
    // One row past the bound says whether the object has more than was examined.
    step: { object: input.object, ...(input.fields ? { fields: input.fields } : {}), filters: [], sort: [], limit: limit + 1 },
  });
  const complete = read.rows.length <= limit;
  const rows = complete ? read.rows : read.rows.slice(0, limit);
  const declared = new Map(read.fields.map((f) => [f.name, f.type]));
  const names = input.fields ?? read.fields.map((f) => f.name);
  return {
    object: input.object, rowsExamined: rows.length, complete, connectorVersion: read.connectorVersion,
    fields: names.map((name) => profileField(name, declared.get(name) ?? 'json', rows.map((row) => row[name]), complete)),
  };
}
