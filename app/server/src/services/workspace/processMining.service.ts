// Process mining (D234): how cases actually moved through activities, reconstructed from events
// (a case, an activity, a time). Each case's events in time order form its trace. From the traces:
// the activities (how often, in how many cases, how often a case starts or ends there); the
// directly-follows graph (each step from one activity to the next, how often, and how long it took:
// median and 90th percentile); the variants (distinct traces, most common first, each with its share
// and median duration); case durations; rework (an activity a case does more than once); and, given a
// reference model (the steps allowed, where a case may start and end), conformance: which cases fit,
// and the steps that deviate. Pure: no I/O, deterministic for the same events.

export interface ProcessEvent { case: string; activity: string; at: number }
export interface ReferenceModel { transitions: readonly (readonly [string, string])[]; starts: readonly string[]; ends: readonly string[] }

export interface Mined {
  events: number;
  cases: number;
  activities: { name: string; events: number; cases: number; starts: number; ends: number }[];
  edges: { from: string; to: string; count: number; cases: number; medianSeconds: number | null; p90Seconds: number | null }[];
  variants: { path: string[]; cases: number; share: number; medianSeconds: number | null }[];
  caseDuration: { medianSeconds: number | null; p90Seconds: number | null; maxSeconds: number | null };
  rework: { activity: string; cases: number }[];
  conformance: {
    fitting: number; deviating: number;
    deviations: { from: string; to: string; cases: number }[];
    badStarts: { activity: string; cases: number }[];
    badEnds: { activity: string; cases: number }[];
  } | null;
}

/** The value at a quantile of sorted numbers (nearest rank). */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}
const seconds = (ms: number) => Math.round(ms / 1000);

/** Each case's events in time order (ties by activity name, so the same events give the same traces). */
export function traces(events: readonly ProcessEvent[]): Map<string, ProcessEvent[]> {
  const byCase = new Map<string, ProcessEvent[]>();
  for (const e of events) {
    const list = byCase.get(e.case);
    if (list === undefined) byCase.set(e.case, [e]); else list.push(e);
  }
  for (const list of byCase.values()) list.sort((a, b) => a.at - b.at || (a.activity < b.activity ? -1 : a.activity > b.activity ? 1 : 0));
  return byCase;
}

export function mine(events: readonly ProcessEvent[], reference?: ReferenceModel, topVariants = 20): Mined {
  const byCase = traces(events);
  const activities = new Map<string, { events: number; cases: Set<string>; starts: number; ends: number }>();
  const edges = new Map<string, { from: string; to: string; count: number; cases: Set<string>; durations: number[] }>();
  const variants = new Map<string, { path: string[]; cases: number; durations: number[] }>();
  const rework = new Map<string, number>();
  const durations: number[] = [];
  const allowed = reference === undefined ? undefined : new Set(reference.transitions.map(([a, b]) => `${a}\u0000${b}`));
  const starts = reference === undefined ? undefined : new Set(reference.starts);
  const ends = reference === undefined ? undefined : new Set(reference.ends);
  const deviations = new Map<string, { from: string; to: string; cases: Set<string> }>();
  const badStarts = new Map<string, number>();
  const badEnds = new Map<string, number>();
  let fitting = 0;

  for (const [id, trace] of byCase) {
    const seen = new Map<string, number>();
    trace.forEach((e, i) => {
      const a = activities.get(e.activity) ?? { events: 0, cases: new Set<string>(), starts: 0, ends: 0 };
      a.events += 1;
      a.cases.add(id);
      if (i === 0) a.starts += 1;
      if (i === trace.length - 1) a.ends += 1;
      activities.set(e.activity, a);
      seen.set(e.activity, (seen.get(e.activity) ?? 0) + 1);
      if (i > 0) {
        const prev = trace[i - 1]!;
        const k = `${prev.activity}\u0000${e.activity}`;
        const edge = edges.get(k) ?? { from: prev.activity, to: e.activity, count: 0, cases: new Set<string>(), durations: [] };
        edge.count += 1;
        edge.cases.add(id);
        edge.durations.push(e.at - prev.at);
        edges.set(k, edge);
      }
    });
    for (const [activity, n] of seen) if (n > 1) rework.set(activity, (rework.get(activity) ?? 0) + 1);
    const duration = trace[trace.length - 1]!.at - trace[0]!.at;
    durations.push(duration);
    const path = trace.map((e) => e.activity);
    const vk = path.join('\u0000');
    const v = variants.get(vk) ?? { path, cases: 0, durations: [] };
    v.cases += 1;
    v.durations.push(duration);
    variants.set(vk, v);

    if (allowed !== undefined) {
      let fits = true;
      if (!starts!.has(path[0]!)) { fits = false; badStarts.set(path[0]!, (badStarts.get(path[0]!) ?? 0) + 1); }
      if (!ends!.has(path[path.length - 1]!)) { fits = false; badEnds.set(path[path.length - 1]!, (badEnds.get(path[path.length - 1]!) ?? 0) + 1); }
      for (let i = 1; i < path.length; i++) {
        const k = `${path[i - 1]}\u0000${path[i]}`;
        if (allowed.has(k)) continue;
        fits = false;
        const d = deviations.get(k) ?? { from: path[i - 1]!, to: path[i]!, cases: new Set<string>() };
        d.cases.add(id);
        deviations.set(k, d);
      }
      if (fits) fitting += 1;
    }
  }

  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const cases = byCase.size;
  const caseSorted = sorted(durations);
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    events: events.length,
    cases,
    activities: [...activities].map(([name, a]) => ({ name, events: a.events, cases: a.cases.size, starts: a.starts, ends: a.ends }))
      .sort((a, b) => b.events - a.events || byName(a, b)),
    edges: [...edges.values()].map((e) => {
      const d = sorted(e.durations);
      const median = quantile(d, 0.5);
      const p90 = quantile(d, 0.9);
      return { from: e.from, to: e.to, count: e.count, cases: e.cases.size, medianSeconds: median === null ? null : seconds(median), p90Seconds: p90 === null ? null : seconds(p90) };
    }).sort((a, b) => b.count - a.count || (a.from + a.to < b.from + b.to ? -1 : 1)),
    variants: [...variants.values()].sort((a, b) => b.cases - a.cases || (a.path.join('>') < b.path.join('>') ? -1 : 1)).slice(0, topVariants).map((v) => {
      const median = quantile(sorted(v.durations), 0.5);
      return { path: v.path, cases: v.cases, share: cases === 0 ? 0 : v.cases / cases, medianSeconds: median === null ? null : seconds(median) };
    }),
    caseDuration: {
      medianSeconds: caseSorted.length === 0 ? null : seconds(quantile(caseSorted, 0.5)!),
      p90Seconds: caseSorted.length === 0 ? null : seconds(quantile(caseSorted, 0.9)!),
      maxSeconds: caseSorted.length === 0 ? null : seconds(caseSorted[caseSorted.length - 1]!),
    },
    rework: [...rework].map(([activity, n]) => ({ activity, cases: n })).sort((a, b) => b.cases - a.cases || (a.activity < b.activity ? -1 : 1)),
    conformance: reference === undefined ? null : {
      fitting, deviating: cases - fitting,
      deviations: [...deviations.values()].map((d) => ({ from: d.from, to: d.to, cases: d.cases.size })).sort((a, b) => b.cases - a.cases).slice(0, 20),
      badStarts: [...badStarts].map(([activity, n]) => ({ activity, cases: n })).sort((a, b) => b.cases - a.cases),
      badEnds: [...badEnds].map(([activity, n]) => ({ activity, cases: n })).sort((a, b) => b.cases - a.cases),
    },
  };
}

/**
 * Events from a state property's captured changes: a case is an object, an activity the value it
 * moved into, at the time Capture observed it; a case's first transition also yields the value it
 * left, at that same time, so where it started is not lost.
 */
export function eventsFromTransitions(transitions: readonly { objectRef: string; previousValue: unknown; newValue: unknown; observedAt: string }[]): ProcessEvent[] {
  const text = (v: unknown) => (v === null || v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const ordered = [...transitions].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const started = new Set<string>();
  const out: ProcessEvent[] = [];
  for (const t of ordered) {
    const at = Date.parse(t.observedAt);
    if (!started.has(t.objectRef)) {
      started.add(t.objectRef);
      if (t.previousValue !== null && t.previousValue !== undefined) out.push({ case: t.objectRef, activity: text(t.previousValue), at: at - 1 });
    }
    out.push({ case: t.objectRef, activity: text(t.newValue), at });
  }
  return out;
}
