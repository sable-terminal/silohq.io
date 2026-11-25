'use client';

// A refusal from the query engine (spec 12.1): a correct answer, not a fault. It says why, the
// bound it would have crossed (its name, the limit, what was observed), and what would work
// instead; never partial data.

import { Banner } from './banner.component.tsx';
import { formatNumber, humanise } from '../utils/format.util.ts';

export interface Refusal {
  code: string;
  reason: string;
  element?: { kind: string; id?: string | undefined; name?: string | undefined } | undefined;
  bound?: { name: string; limit: number; observed?: number | undefined; connectionId?: string | undefined } | undefined;
  remedy?: string | undefined;
}

const sentence = (text: string) => {
  const t = text.trim();
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
};

export function RefusalNotice({ refusal, title = 'Not shown' }: { refusal: Refusal; title?: string }) {
  return (
    <Banner tone="info" title={title}>
      {sentence(refusal.reason)}
      {refusal.bound !== undefined ? ` The bound is ${formatNumber(refusal.bound.limit)} (${humanise(refusal.bound.name).toLowerCase()})${refusal.bound.observed !== undefined ? `; this would read ${formatNumber(refusal.bound.observed)}` : ''}.` : ''}
      {refusal.element?.name !== undefined ? ` It concerns ${refusal.element.name}.` : ''}
      {refusal.remedy !== undefined ? ` ${sentence(refusal.remedy)}` : ''}
    </Banner>
  );
}
