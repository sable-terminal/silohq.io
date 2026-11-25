import { childLogger } from '../config/logger.config';

const log = childLogger('metrics');

/**
 * Counters and histograms.
 *
 * IN PROCESS, SCRAPED RATHER THAN PUSHED. Cloud Run instances come and go, and a
 * push-based client on a dying instance loses its last window — which is exactly
 * the window that explains why it died.
 *
 * LABELS ARE A CLOSED SET PER METRIC, AND UNBOUNDED ONES ARE THE CLASSIC
 * MISTAKE. A label taking an organisation id, a user id or a question produces a
 * new time series per value, and a monitoring bill that grows with the customer
 * base. Tenant-level detail belongs in the audit trail, which is queryable and
 * retained deliberately.
 */

type Labels = Record<string, string>;

interface Series {
  help: string;
  values: Map<string, number>;
  /** Bucket upper bounds, for a histogram. */
  buckets?: number[];
}

const counters = new Map<string, Series>();
const histograms = new Map<string, Series>();

/** Labels that must never be used, because their cardinality is unbounded. */
const FORBIDDEN_LABELS = new Set(['organisation_id', 'membership_id', 'user_id', 'question', 'email']);

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));

  for (const [name] of entries) {
    if (FORBIDDEN_LABELS.has(name)) {
      // Dropped rather than thrown: a metrics mistake must not break a request.
      log.warn({ label: name }, 'Unbounded metric label dropped');
      return entries.filter(([n]) => !FORBIDDEN_LABELS.has(n)).map(([n, v]) => `${n}=${v}`).join(',');
    }
  }

  return entries.map(([n, v]) => `${n}=${v}`).join(',');
}

export function counter(name: string, help: string, labels: Labels = {}, by = 1): void {
  let series = counters.get(name);
  if (!series) {
    series = { help, values: new Map() };
    counters.set(name, series);
  }
  const key = labelKey(labels);
  series.values.set(key, (series.values.get(key) ?? 0) + by);
}

/**
 * Buckets in milliseconds.
 *
 * CHOSEN AROUND THE THRESHOLDS THAT MATTER, not evenly spaced. The interesting
 * questions are "how many compiles took over a second" and "how many took over
 * ten", so there are boundaries there. Even spacing puts all the resolution where
 * nothing happens.
 */
const DEFAULT_BUCKETS = [5, 25, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];

export function observe(name: string, help: string, valueMs: number, labels: Labels = {}): void {
  let series = histograms.get(name);
  if (!series) {
    series = { help, values: new Map(), buckets: DEFAULT_BUCKETS };
    histograms.set(name, series);
  }

  const base = labelKey(labels);
  for (const bucket of series.buckets!) {
    if (valueMs <= bucket) {
      const key = `${base}|le=${bucket}`;
      series.values.set(key, (series.values.get(key) ?? 0) + 1);
    }
  }
  const infKey = `${base}|le=+Inf`;
  series.values.set(infKey, (series.values.get(infKey) ?? 0) + 1);

  const sumKey = `${base}|sum`;
  series.values.set(sumKey, (series.values.get(sumKey) ?? 0) + valueMs);
}

/** Prometheus text format, for a scrape endpoint. */
export function render(): string {
  const lines: string[] = [];

  for (const [name, series] of counters) {
    lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} counter`);
    for (const [labels, value] of series.values) {
      lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }
  }

  for (const [name, series] of histograms) {
    lines.push(`# HELP ${name} ${series.help}`, `# TYPE ${name} histogram`);
    for (const [key, value] of series.values) {
      const [labels, suffix] = key.split('|');
      if (suffix === 'sum') {
        lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${value}`);
      } else {
        const inner = [labels, suffix].filter(Boolean).join(',');
        lines.push(`${name}_bucket{${inner}} ${value}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

export function reset(): void {
  counters.clear();
  histograms.clear();
}
