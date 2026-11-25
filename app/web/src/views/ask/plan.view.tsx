'use client';

// How Silo answered a question, in words (spec 36.3): the types it read, the filters and the
// period as the asker wrote them, the links it walked, how it grouped and counted, and in what
// order. Read from the compiled plan, which holds references and parameters, never values: a
// filter's value is a parameter, said as "a value you gave".

import type { Output } from '../../api/client.api.ts';
import { useVocabulary, type Lookup } from '../../hooks/vocabulary.hook.ts';
import styles from './ask.view.module.css';

type Plan = Output<'readCompiledPlan'>['plan'];

const OPS: Record<string, string> = {
  eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', in: 'is one of', contains: 'contains',
  starts_with: 'starts with', is_null: 'is empty', is_not_null: 'is not empty',
};
const FNS: Record<string, string> = { count: 'counted', sum: 'the sum of', min: 'the lowest', max: 'the highest', avg: 'the average of', count_distinct: 'the number of different' };

export function planWords(plan: Plan, lookup: Lookup | undefined): string[] {
  const nodeName = (i: number) => {
    const node = plan.nodes[i];
    if (node === undefined) return 'objects';
    return node.objectTypeId !== undefined ? lookup?.typeName(node.objectTypeId, true) ?? 'objects' : lookup?.interfaces.get(node.interfaceId ?? '')?.displayName ?? 'objects';
  };
  const prop = (id: string | undefined) => (id === undefined ? 'objects' : lookup?.propertyName(id) ?? 'a property');
  const lines: string[] = [];
  lines.push(`Read ${nodeName(0)}.`);
  plan.hops.forEach((hop) => {
    const link = lookup?.links.get(hop.linkTypeId);
    lines.push(`Followed ${link === undefined ? 'a link' : `“${link.forwardName}”`} to ${nodeName(hop.to)}.`);
  });
  plan.nodes.forEach((node, i) => {
    for (const f of node.filters) lines.push(`Kept ${nodeName(i)} where ${prop(f.property)} ${OPS[f.op] ?? f.op}${f.value !== undefined ? ' a value you gave' : ''}.`);
    if (node.period !== undefined) lines.push(`Limited ${nodeName(i)} by ${prop(node.period.property)} to “${node.period.asWritten}”.`);
  });
  if (plan.aggregate !== undefined) {
    const groups = plan.aggregate.groupBy.map((g) => prop(g.property));
    const measures = plan.aggregate.measures.map((m) => (m.fn === 'count' ? `counted ${nodeName(m.node)}` : `${FNS[m.fn] ?? m.fn} ${prop(m.property)}`));
    lines.push(`${measures.join(' and ').replace(/^./, (c) => c.toUpperCase())}${groups.length > 0 ? `, for each ${groups.join(' and ')}` : ''}.`);
  } else if (plan.select.length > 0) {
    lines.push(`Showed ${plan.select.map((s) => prop(s.property)).join(', ')}.`);
  }
  if (plan.sort.length > 0) lines.push(`In order of ${plan.sort.map((s) => `${s.measure ?? prop(s.property)} (${s.direction === 'asc' ? 'lowest first' : 'highest first'})`).join(', then ')}.`);
  if (plan.limit !== undefined) lines.push(`At most ${plan.limit}.`);
  if (plan.asOf !== undefined) lines.push(`As it stood at “${plan.asOf.asWritten}”.`);
  if (plan.history !== undefined) lines.push(`How it changed over “${plan.history.asWritten}”.`);
  return lines;
}

export function PlanWords({ plan }: { plan: Plan }) {
  const { lookup } = useVocabulary();
  return <ol className={styles.planWords}>{planWords(plan, lookup).map((line, i) => <li key={i}>{line}</li>)}</ol>;
}
