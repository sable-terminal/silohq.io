// The answer in sentences (spec 31.2): assembled from the result object and nothing else, so the
// sentence and the table cannot disagree. Figures carry where they came from: the systems read and
// when, the period resolved, and what was left out and why.

import { formatDate, formatDateTime, formatNumber, humanise, plural } from '../utils/format.util.ts';
import { formatValue, type DataType } from '../utils/value.util.ts';
import type { Measure, Result, Shape } from './structure.result.ts';

export interface Names {
  /** A property's name by its identity, as the reader's vocabulary says it. */
  property: (identityId: string) => string | undefined;
  /** An object type's name, plural or not. */
  type: (objectTypeId: string, plural?: boolean) => string | undefined;
  /** A connection's name. */
  connection: (connectionId: string) => string | undefined;
}

const FN: Readonly<Record<Measure['fn'], string>> = { count: 'Number of', sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count_distinct: 'Distinct' };

/** A measure's name: "Total amount", "Average days late", "Objects". */
export function measureName(m: Measure, names: Names): string {
  if (m.fn === 'count') return 'Objects';
  const property = (m.property !== undefined ? names.property(m.property) : undefined) ?? humanise(m.as);
  return m.fn === 'count_distinct' ? `Distinct ${property.toLowerCase()}` : `${FN[m.fn]} ${property.toLowerCase()}`;
}

const keyText = (result: Result, key: Record<string, unknown>) => Object.entries(key).map(([api, v]) => {
  const column = result.columns.find((c) => c.apiName === api);
  return v === null || v === undefined ? 'none' : formatValue(column?.dataType as DataType | undefined, v);
}).join(', ');

const list = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

/** The answer's sentences, the figures first and what shaped them after. */
export function proseOf(result: Result, shape: Shape, names: Names): string[] {
  const out: string[] = [];
  if (result.kind === 'objects') {
    const typeId = result.page.objects[0]?.objectTypeId;
    const noun = (typeId !== undefined ? names.type(typeId, result.total !== 1) : undefined)?.toLowerCase() ?? (result.total === 1 ? 'object' : 'objects');
    out.push(`${formatNumber(result.total)} ${noun} ${result.total === 1 ? 'matches' : 'match'}.`);
    const n = shape.number;
    if (n !== undefined && shape.whole) {
      const values = result.page.objects.filter((o) => !o.disputed.includes(n.apiName)).map((o) => o.values[n.apiName]).filter((v): v is number => typeof v === 'number');
      if (values.length > 1) {
        out.push(`${n.displayName} runs from ${formatValue(n.dataType as DataType, Math.min(...values))} to ${formatValue(n.dataType as DataType, Math.max(...values))}.`);
      }
    }
  } else {
    const m = result.measures[0];
    const groups = result.page.groups;
    if (m !== undefined && groups.length === 1 && Object.keys(groups[0]!.key).length === 0) {
      out.push(`${measureName(m, names)} is ${formatNumber(groups[0]!.measures[m.as] ?? null, 2)}${result.measures.length > 1 ? `; ${list(result.measures.slice(1).map((x) => `${measureName(x, names).toLowerCase()} ${formatNumber(groups[0]!.measures[x.as] ?? null, 2)}`))}` : ''}.`);
    } else if (m !== undefined && groups.length > 0) {
      const by = result.columns.filter((c) => c.apiName in groups[0]!.key).map((c) => c.displayName.toLowerCase());
      const label = `${measureName(m, names)} by ${list(by)}`;
      const valued = groups.filter((g) => g.measures[m.as] !== null && g.measures[m.as] !== undefined);
      if (shape.fits.includes('series') && shape.structure.orderedByTime && valued.length >= 2) {
        const first = valued[0]!;
        const last = valued.at(-1)!;
        const top = valued.reduce((a, b) => (b.measures[m.as]! > a.measures[m.as]! ? b : a));
        out.push(`${label}: ${formatNumber(first.measures[m.as]!, 2)} in ${keyText(result, first.key)}, to ${formatNumber(last.measures[m.as]!, 2)} in ${keyText(result, last.key)}; highest ${formatNumber(top.measures[m.as]!, 2)} in ${keyText(result, top.key)}.`);
      } else if (valued.length > 0) {
        const ranked = [...valued].sort((a, b) => b.measures[m.as]! - a.measures[m.as]!);
        const lead = ranked.slice(0, 3).map((g) => `${keyText(result, g.key)} (${formatNumber(g.measures[m.as]!, 2)})`);
        out.push(`${label}: highest ${list(lead)}${shape.whole ? `; ${plural(result.total, 'group')} in all` : `; the first ${formatNumber(groups.length)} of ${formatNumber(result.total)} groups are read here`}.`);
        if (shape.structure.sumsToWhole) {
          const total = valued.reduce((sum, g) => sum + g.measures[m.as]!, 0);
          if (total > 0) out.push(`${keyText(result, ranked[0]!.key)} is ${formatNumber((100 * ranked[0]!.measures[m.as]!) / total, 1)}% of the ${formatNumber(total, 2)} in all.`);
        }
      }
    }
    const left = Object.entries(groups.reduce<Record<string, number>>((acc, g) => {
      for (const [k, v] of Object.entries(g.excluded)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {})).filter(([, v]) => v > 0);
    for (const [as, n] of left) {
      const measure = result.measures.find((x) => x.as === as);
      out.push(`${plural(n, 'value')} left out of ${measure !== undefined ? measureName(measure, names).toLowerCase() : humanise(as)}, disputed or empty.`);
    }
  }
  return [...out, ...contextOf(result, names)];
}

/** What shaped the answer: the period, the systems and when, what was not counted, what was not visible. */
export function contextOf(result: Result, names: Names): string[] {
  const out: string[] = [];
  for (const p of result.periods) {
    const fmt = p.basis === 'date' ? formatDate : formatDateTime;
    out.push(`${p.asWritten}: from ${fmt(p.from)} to before ${fmt(p.to)}, by ${names.property(p.property) ?? humanise(p.propertyApiName)}${p.defaultTimeField ? ' (the type\'s usual time field)' : ''}.`);
  }
  const sources = new Map<string, string>();
  for (const l of result.lineage) for (const s of l.sources) if ((sources.get(s.connectionId) ?? '') < s.readAt) sources.set(s.connectionId, s.readAt);
  if (sources.size > 0) {
    const latest = [...sources.values()].sort().at(-1)!;
    out.push(`Read from ${list([...sources.keys()].map((id) => names.connection(id) ?? 'a connection'))}, ${formatDateTime(latest)}.`);
  }
  const served = result.lineage.find((l) => l.servedBy !== undefined)?.servedBy;
  if (served !== undefined) out.push(`Answered from the ${served.kind === 'index' ? 'Object Index' : 'Warehouse'} as of ${formatDateTime(served.asOf)}: ${served.reason}.`);
  const disputed = Object.entries(result.coverage.disputed).filter(([, n]) => n > 0);
  if (disputed.length > 0) out.push(`Systems disagree on ${list(disputed.map(([api, n]) => `${plural(n, 'value')} of ${result.columns.find((c) => c.apiName === api)?.displayName.toLowerCase() ?? humanise(api)}`))}; both are shown on each object, never averaged.`);
  if (result.coverage.excludedByDispute > 0) out.push(`${plural(result.coverage.excludedByDispute, 'object')} left out because a filter fell on a value the systems disagree on.`);
  if (result.coverage.unmatched > 0) out.push(`${plural(result.coverage.unmatched, 'record')} could not be matched to an object.`);
  const unchecked = Object.entries(result.coverage.unchecked).filter(([, n]) => n > 0);
  if (unchecked.length > 0) out.push(`${list(unchecked.map(([api, n]) => `${plural(n, 'value')} of ${humanise(api).toLowerCase()}`))} could not be asked of any system: unknown, not empty.`);
  if (result.reduced) out.push('Some values are not visible to you, so they are masked or left out.');
  if (result.branch !== undefined) out.push(`Computed against a ${result.branch.kind} branch of the ontology, not main.`);
  return out;
}
