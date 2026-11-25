/**
 * Where a figure came from, carried with the figure.
 *
 * ATTACHED AT THE POINT OF READ, NOT RECONSTRUCTED LATER. Lineage worked out
 * afterwards is a guess about which source produced which number, and it is
 * wrong exactly when it matters — after a merge, where two systems contributed to
 * one total.
 *
 * IT SURVIVES AGGREGATION. Summing ten invoices produces one number with ten
 * sources, not one number with the first source or none. That is why lineage is a
 * set rather than a field.
 */

export interface Source {
  connectionId: string;
  connectionName: string;
  connectorVersion: string;
  /** The field as the source system names it: `invoice.total`, not `amount`. */
  fieldPath: string;
  readAt: Date;
}

export interface Traced<T> {
  value: T;
  sources: readonly Source[];
}

export function trace<T>(value: T, source: Source): Traced<T> {
  return { value, sources: [source] };
}

/** Combine traced values, keeping every contributing source. */
export function combine<T, R>(inputs: readonly Traced<T>[], reduce: (values: T[]) => R): Traced<R> {
  const sources = new Map<string, Source>();
  for (const input of inputs) {
    for (const source of input.sources) {
      // Keyed by connection and field, so ten invoices from one system are one
      // source rather than ten identical entries.
      sources.set(`${source.connectionId}:${source.fieldPath}`, source);
    }
  }
  return { value: reduce(inputs.map((i) => i.value)), sources: [...sources.values()] };
}

/** A one-line attribution for display beside a figure. */
export function describe(traced: Traced<unknown>): string {
  if (traced.sources.length === 0) return 'no recorded source';
  if (traced.sources.length === 1) {
    const s = traced.sources[0]!;
    return `${s.connectionName} · ${s.fieldPath} · connector ${s.connectorVersion}`;
  }
  const names = [...new Set(traced.sources.map((s) => s.connectionName))];
  return `${traced.sources.length} fields across ${names.join(', ')}`;
}

/**
 * Whether every part of a figure could be traced.
 *
 * AN UNTRACED FIGURE MUST NOT BE DISPLAYED. It is a number with no provenance in
 * a product whose claim is that every number has one. Better to refuse than to
 * show a figure that cannot be opened.
 */
export function isFullyTraced(traced: Traced<unknown>): boolean {
  return traced.sources.length > 0;
}
