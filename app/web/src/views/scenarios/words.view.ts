// Simulation figures as a person reads them (spec 39): an ISO 8601 duration in words, a
// probability with its interval, an edge's evidence, why a walk stopped, how a failure is stated.

const UNITS: [RegExp, string][] = [[/(\d+(?:\.\d+)?)W/, 'week'], [/(\d+(?:\.\d+)?)D/, 'day'], [/T.*?(\d+(?:\.\d+)?)H/, 'hour'], [/T.*?(\d+(?:\.\d+)?)M/, 'minute'], [/T.*?(\d+(?:\.\d+)?)S/, 'second']];

/** Seconds in words, at most two units: "1 day 2 hours". */
export function seconds(total: number): string {
  const parts: string[] = [];
  let left = Math.round(total);
  for (const [unit, size] of [['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]] as const) {
    const n = Math.floor(left / size);
    if (n > 0 && parts.length < 2) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
    left -= n * size;
  }
  return parts.length === 0 ? 'no time' : parts.join(' ');
}

/** "P1DT2H" → "1 day 2 hours"; a plain seconds form ("PT43200S") in its largest units; null → it fails outright. */
export function duration(iso: string | null): string {
  if (iso === null) return 'fails outright';
  const onlySeconds = /^PT(\d+(?:\.\d+)?)S$/.exec(iso);
  if (onlySeconds !== null) return Number(onlySeconds[1]) === 0 ? 'no delay' : seconds(Number(onlySeconds[1]));
  const parts = UNITS.flatMap(([re, unit]) => {
    const m = re.exec(iso);
    if (m === null || Number(m[1]) === 0) return [];
    return [`${m[1]} ${unit}${Number(m[1]) === 1 ? '' : 's'}`];
  });
  return parts.length === 0 ? 'no delay' : parts.join(' ');
}

export const percent = (p: number) => `${Math.round(p * 1000) / 10}%`;

export const EDGE_SOURCE: Record<'structure' | 'history' | 'stated', string> = { structure: 'from the model', history: 'observed', stated: 'stated' };
export const EDGE_KIND: Record<'hard' | 'soft' | 'resource', string> = {
  hard: 'Hard: it cannot happen without it', soft: 'Soft: it proceeds, degraded', resource: 'Resource: they share its capacity',
};
export const STOP_REASON: Record<'unconfirmed_edge' | 'bounded_hop' | 'uncleared_object_type', string> = {
  unconfirmed_edge: 'an edge on the path is not confirmed',
  bounded_hop: 'the walk reached its bound at this hop',
  uncleared_object_type: 'the path crosses a type you may not see',
};
export const FAILURE_FORM: Record<'unavailable' | 'delayed' | 'unavailable_for_period' | 'reduced_capacity', string> = {
  unavailable: 'unavailable', delayed: 'delayed', unavailable_for_period: 'out for a period', reduced_capacity: 'at reduced capacity',
};
export const STALENESS: Record<'clean' | 'conflicted' | 'already_applied' | 'orphaned', { label: string; tone: 'ok' | 'warn' | 'neutral' | 'danger' }> = {
  clean: { label: 'Clean', tone: 'ok' }, conflicted: { label: 'Conflicted', tone: 'warn' }, already_applied: { label: 'Already applied', tone: 'neutral' }, orphaned: { label: 'Orphaned', tone: 'danger' },
};
export const BRANCH_STATUS: Record<'open' | 'promoted' | 'partially_promoted' | 'closed', { label: string; tone: 'info' | 'ok' | 'warn' | 'neutral' }> = {
  open: { label: 'Open', tone: 'info' }, promoted: { label: 'Promoted', tone: 'ok' }, partially_promoted: { label: 'Partly promoted', tone: 'warn' }, closed: { label: 'Closed', tone: 'neutral' },
};
export const UNITS_OF_TIME = ['minutes', 'hours', 'days', 'weeks'] as const;
