// Advisories (spec 11.1): OSV records, reduced to what matching needs, and whether one
// affects a component's version (OSV schema 1.6, "Evaluation").
//
// Severity is the highest rating the record gives anywhere: a CVSS v3 vector's base score
// (record or affected entry), or the database's own rating (GHSA's CRITICAL to LOW, a
// distribution's urgency). A malicious-package record (MAL-) is critical: the package is
// the attack. A record with none is unrated here; the check then looks to other records it
// shares an alias with (a GHSA and a distribution's record of one CVE).
//
// A version is affected when an affected entry lists it, or it falls in one of the entry's
// ranges: from an introduced event (or "0") up to a fixed event, or through last_affected.
// SEMVER ranges use Semantic Versioning order, ECOSYSTEM ranges the ecosystem's own
// (utils/versions.util.ts). A range Silo cannot order (no comparator for the ecosystem, or a
// version its scheme cannot read) gives "unresolved", which counts as affected: an
// unproven match is never taken as safe. GIT ranges name commits and are not evaluated.

import { cvss3BaseScore, ratingOf, type Severity } from '../../utils/cvss.util.ts';
import { normalisePypiName } from '../../utils/purl.util.ts';
import { comparatorFor, compareSemver, type Comparator } from '../../utils/versions.util.ts';

export type Rating = Severity | 'unrated';

export interface AffectedEntry {
  ecosystem: string;
  name: string;
  versions: string[];
  ranges: { type: string; events: Record<string, string>[] }[];
}

export interface OsvAdvisory {
  id: string;
  modified: string;
  withdrawn: string | null;
  aliases: string[];
  summary: string | null;
  severity: Rating;
  score: number | null;
  affected: AffectedEntry[];
}

const RANK: Record<Rating, number> = { unrated: -1, none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const higher = (a: Rating, b: Rating): Rating => (RANK[a] >= RANK[b] ? a : b);
export const rankOf = (r: Rating): number => RANK[r];

const DATABASE_RATINGS: Record<string, Severity> = {
  critical: 'critical', high: 'high', important: 'high', moderate: 'medium', medium: 'medium', low: 'low', negligible: 'low',
  unimportant: 'low', 'not yet assigned': 'none',
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function ratingFrom(holder: unknown): { rating: Rating; score: number | null } {
  let rating: Rating = 'unrated';
  let score: number | null = null;
  if (!isObject(holder)) return { rating, score };
  for (const entry of Array.isArray(holder['severity']) ? holder['severity'] : []) {
    if (!isObject(entry) || typeof entry['score'] !== 'string') continue;
    if (entry['type'] === 'CVSS_V3') {
      const s = cvss3BaseScore(entry['score']);
      if (s !== undefined && (score === null || s > score)) score = s;
      if (s !== undefined) rating = higher(rating, ratingOf(s));
    } else if (entry['type'] === 'Ubuntu') {
      const r = DATABASE_RATINGS[entry['score'].toLowerCase()];
      if (r !== undefined) rating = higher(rating, r);
    }
  }
  for (const specific of [holder['database_specific'], holder['ecosystem_specific']]) {
    if (!isObject(specific)) continue;
    for (const key of ['severity', 'urgency']) {
      const value = specific[key];
      const r = typeof value === 'string' ? DATABASE_RATINGS[value.toLowerCase()] : undefined;
      if (r !== undefined) rating = higher(rating, r);
    }
  }
  return { rating, score };
}

/** An OSV record, reduced; undefined when it is not one (no id or modified time). */
export function advisoryOf(record: unknown): OsvAdvisory | undefined {
  if (!isObject(record) || typeof record['id'] !== 'string' || typeof record['modified'] !== 'string' || Number.isNaN(Date.parse(record['modified']))) {
    return undefined;
  }
  let { rating, score } = ratingFrom(record);
  const affected: AffectedEntry[] = [];
  for (const entry of Array.isArray(record['affected']) ? record['affected'] : []) {
    if (!isObject(entry) || !isObject(entry['package'])) continue;
    const ecosystem = entry['package']['ecosystem'];
    const name = entry['package']['name'];
    if (typeof ecosystem !== 'string' || typeof name !== 'string') continue;
    const own = ratingFrom(entry);
    rating = higher(rating, own.rating);
    if (own.score !== null && (score === null || own.score > score)) score = own.score;
    affected.push({
      ecosystem,
      name: ecosystem === 'PyPI' ? normalisePypiName(name) : name,
      versions: strings(entry['versions']),
      ranges: (Array.isArray(entry['ranges']) ? entry['ranges'] : []).filter(isObject).map((r) => ({
        type: String(r['type']),
        events: (Array.isArray(r['events']) ? r['events'] : []).filter(isObject).map((e) => Object.fromEntries(
          Object.entries(e).filter((kv): kv is [string, string] => typeof kv[1] === 'string'))),
      })),
    });
  }
  if (record['id'].startsWith('MAL-')) rating = 'critical';
  return {
    id: record['id'], modified: new Date(Date.parse(record['modified'])).toISOString(),
    withdrawn: typeof record['withdrawn'] === 'string' && !Number.isNaN(Date.parse(record['withdrawn'])) ? new Date(Date.parse(record['withdrawn'])).toISOString() : null,
    aliases: strings(record['aliases']).slice(0, 100),
    summary: typeof record['summary'] === 'string' ? record['summary'].slice(0, 1000) : null,
    severity: rating, score, affected,
  };
}

/** The packages an advisory names, for the index. */
export const packagesOf = (advisory: OsvAdvisory): { ecosystem: string; name: string }[] =>
  [...new Map(advisory.affected.map((a) => [`${a.ecosystem}\u0000${a.name}`, { ecosystem: a.ecosystem, name: a.name }])).values()];

type Outcome = 'affected' | 'unresolved' | 'not_affected';

function inRange(version: string, events: Record<string, string>[], compare: Comparator): Outcome {
  // Order the events by version, "0" first; a version that cannot be ordered leaves it unresolved.
  const keyed: { kind: string; at: string }[] = [];
  for (const event of events) {
    for (const kind of ['introduced', 'fixed', 'last_affected', 'limit']) {
      if (event[kind] !== undefined) keyed.push({ kind, at: event[kind] });
    }
  }
  let unordered = false;
  keyed.sort((a, b) => {
    if (a.at === '0') return -1;
    if (b.at === '0') return 1;
    const c = compare(a.at, b.at);
    if (c === undefined) unordered = true;
    return c ?? 0;
  });
  if (unordered) return 'unresolved';
  let affected = false;
  for (const event of keyed) {
    const c = event.at === '0' ? 1 : compare(version, event.at);
    if (c === undefined) return 'unresolved';
    if (event.kind === 'introduced' && c >= 0) affected = true;
    else if (event.kind === 'fixed' && c >= 0) affected = false;
    else if (event.kind === 'last_affected' && c > 0) affected = false;
    else if (event.kind === 'limit' && c >= 0) affected = false;
  }
  return affected ? 'affected' : 'not_affected';
}

/** Whether an advisory affects this package at this version. */
export function affects(advisory: Pick<OsvAdvisory, 'affected'>, ecosystem: string, name: string, version: string): Outcome {
  let outcome: Outcome = 'not_affected';
  for (const entry of advisory.affected) {
    if (entry.ecosystem !== ecosystem || entry.name !== name) continue;
    if (entry.versions.includes(version)) return 'affected';
    for (const range of entry.ranges) {
      const compare = range.type === 'SEMVER' ? compareSemver : range.type === 'ECOSYSTEM' ? comparatorFor(ecosystem) : undefined;
      if (range.type === 'GIT') continue;
      const result = compare === undefined ? (entry.versions.length > 0 ? 'not_affected' : 'unresolved') : inRange(version, range.events, compare);
      if (result === 'affected') return 'affected';
      if (result === 'unresolved') outcome = 'unresolved';
    }
  }
  return outcome;
}
