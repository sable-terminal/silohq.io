import { combine, type Source, type Traced } from './lineage.util';

/**
 * Joining bounded results from several systems on resolved concepts.
 *
 * PARTIAL RESULTS ARE CARRIED, NEVER DISCARDED AND NEVER HIDDEN. If four systems
 * answer and one times out, the merge produces the four with the fifth's absence
 * recorded. Dropping it silently makes a total that is wrong by exactly the
 * missing system; refusing the whole thing wastes four good answers. The caller
 * decides, and it can only decide if it is told.
 *
 * CONFLICTS ARE KEPT, NOT RESOLVED. Two systems disagreeing about a supplier's
 * address is a fact about the customer's data, and picking one by rule — most
 * recent, most trusted — invents an answer and hides the disagreement. The
 * conflict is surfaced with both values and their sources.
 */

export interface SourceResult<T> {
  connectionId: string;
  connectionName: string;
  rows: T[];
  source: Source;
  /** Set when this source did not answer. The rows will be empty. */
  failure?: { reason: string; retryable: boolean };
}

export interface Conflict {
  key: string;
  field: string;
  values: Array<{ value: unknown; connectionId: string; connectionName: string }>;
}

export interface MergeResult<T> {
  rows: Array<Traced<T>>;
  conflicts: Conflict[];
  /** Sources that did not answer. Non-empty means the result is incomplete. */
  missing: Array<{ connectionId: string; connectionName: string; reason: string }>;
  complete: boolean;
}

/**
 * Merge on a resolved key.
 *
 * `keyOf` RETURNS THE RESOLVED ENTITY KEY, NOT A RAW ID. Joining on each system's
 * own identifier merges nothing, because that is the problem the ontology exists
 * to solve.
 */
export function mergeOn<T extends Record<string, unknown>>(
  results: readonly SourceResult<T>[],
  keyOf: (row: T, connectionId: string) => string | null,
): MergeResult<T> {
  const grouped = new Map<string, Array<{ row: T; result: SourceResult<T> }>>();
  const missing: MergeResult<T>['missing'] = [];

  for (const result of results) {
    if (result.failure) {
      missing.push({
        connectionId: result.connectionId,
        connectionName: result.connectionName,
        reason: result.failure.reason,
      });
      continue;
    }

    for (const row of result.rows) {
      const key = keyOf(row, result.connectionId);
      // An unresolvable row is kept as its own entity rather than dropped. It is
      // real data that simply did not match anything.
      const bucket = key ?? `unresolved:${result.connectionId}:${grouped.size}`;
      const existing = grouped.get(bucket) ?? [];
      existing.push({ row, result });
      grouped.set(bucket, existing);
    }
  }

  const rows: Array<Traced<T>> = [];
  const conflicts: Conflict[] = [];

  for (const [key, members] of grouped) {
    const merged = {} as Record<string, unknown>;
    const fieldSources = new Map<string, Array<{ value: unknown; member: (typeof members)[number] }>>();

    for (const member of members) {
      for (const [field, value] of Object.entries(member.row)) {
        if (value === null || value === undefined) continue;
        const seen = fieldSources.get(field) ?? [];
        seen.push({ value, member });
        fieldSources.set(field, seen);
      }
    }

    for (const [field, contributions] of fieldSources) {
      const distinct = [...new Set(contributions.map((c) => JSON.stringify(c.value)))];

      if (distinct.length > 1) {
        conflicts.push({
          key,
          field,
          values: contributions.map((c) => ({
            value: c.value,
            connectionId: c.member.result.connectionId,
            connectionName: c.member.result.connectionName,
          })),
        });
        // The first is carried so the row is usable; the conflict records that a
        // choice was made and what the alternatives were.
      }

      merged[field] = contributions[0]!.value;
    }

    rows.push(
      combine(
        members.map((m) => ({ value: m.row, sources: [m.result.source] })),
        () => merged as T,
      ),
    );
  }

  return { rows, conflicts, missing, complete: missing.length === 0 };
}
