// What every export prints (spec 41.2), whatever its format: the head (its name, the markings
// it carries, when it was computed, its coverage and what this reader may not see) and the
// table. Pure: an answer in, the document's parts out; csv, xlsx and pdf lay them out.
//
// A property the reader may not see in clear is stated, never left as a gap: a redacted
// column is headed as omitted and every cell says so; a masked value is printed masked; a
// disputed value is printed as disputed; an undecided measure as undecided.

import type { QueryResult, ResultObject } from '../../contracts/executor/result.contract.ts';
import type { QueryPlan } from '../../contracts/planner/plan.contract.ts';

export interface DocumentInput {
  name: string;
  markings: readonly string[];
  plan: QueryPlan;
  result: QueryResult;
  /** Every object or group of the answer, in order. */
  rows: readonly unknown[];
}

export interface ExportDocument {
  name: string;
  markings: readonly string[];
  /** Label and value: what must travel with the figures (invariants 7 and 10). */
  head: [string, string | number][];
  header: string[];
  rows: unknown[][];
}

/** The objects a column's node holds for one root object: the root itself, or those reached along the hops. */
function reached(plan: QueryPlan, root: ResultObject, node: number): ResultObject[] {
  if (node === 0) return [root];
  const path: number[] = [];
  for (let at = node; at !== 0;) {
    const hop = plan.hops.findIndex((h) => h.to === at);
    if (hop < 0) return [];
    path.unshift(hop);
    at = plan.hops[hop]!.from;
  }
  let objects = [root];
  for (const hop of path) objects = objects.flatMap((o) => o.links[String(hop)] ?? []);
  return objects;
}

function valueOf(object: ResultObject, apiName: string): unknown {
  if (object.redacted.includes(apiName)) return '[omitted]';
  if (object.disputed.includes(apiName)) return '[disputed]';
  return object.values[apiName];
}

export function exportDocument(input: DocumentInput): ExportDocument {
  const { result, plan } = input;
  const head: ExportDocument['head'] = [
    ['Silo export', input.name],
    ['Markings', input.markings.length === 0 ? 'None' : input.markings.join('; ')],
    ['Computed at', result.computedAt],
    // Computed against a branch of the ontology, never main (spec 25.3): said in every representation.
    ...(result.branch === undefined ? [] : [['Computed on', `an ontology branch (${result.branch.kind}), not main`] as [string, string]]),
    [result.kind === 'groups' ? 'Groups' : 'Objects', result.total],
    ['Population', result.population],
    ['Records without a full match key', result.coverage.unmatched],
    ['Objects excluded by a disputed filter value', result.coverage.excludedByDispute],
  ];
  const disputed = Object.entries(result.coverage.disputed).filter(([, n]) => n > 0);
  if (disputed.length > 0) head.push(['Disputed values', disputed.map(([p, n]) => `${p}: ${n}`).join('; ')]);
  const omitted = result.columns.filter((c) => c.effect === 'redact').map((c) => c.displayName);
  if (omitted.length > 0) head.push(['Omitted for this reader', omitted.join('; ')]);

  if (result.kind === 'groups') {
    const groups = input.rows as QueryResult['page']['groups'];
    const keys = [...new Set(groups.flatMap((g) => Object.keys(g.key)))];
    const measures = result.measures.map((m) => m.as);
    return {
      name: input.name, markings: input.markings, head,
      header: [...keys, ...measures, 'Objects', ...measures.map((m) => `${m}: values left out`)],
      rows: groups.map((group) => [
        ...keys.map((k) => group.key[k]),
        ...measures.map((m) => (group.measures[m] === null || group.measures[m] === undefined ? '[undecided]' : group.measures[m])),
        group.objects,
        ...measures.map((m) => group.excluded[m] ?? 0),
      ]),
    };
  }
  const columns = result.columns;
  return {
    name: input.name, markings: input.markings, head,
    header: columns.map((c) => (c.effect === 'redact' ? `${c.displayName} (omitted)` : c.effect === 'mask' ? `${c.displayName} (masked)` : c.displayName)),
    rows: (input.rows as ResultObject[]).map((root) => columns.map((c) => {
      if (c.node === 0) return valueOf(root, c.apiName);
      return reached(plan, root, c.node).map((o) => valueOf(o, c.apiName)).filter((v) => v !== null && v !== undefined).map(String).join('; ');
    })),
  };
}

/** A cell as text, for formats that print text. */
export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
