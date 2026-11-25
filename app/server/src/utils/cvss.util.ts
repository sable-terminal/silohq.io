// CVSS base scores (FIRST, CVSS v3.0 and v3.1 specifications, section 7): the score of a
// vector string, for deciding which findings are critical (spec 11.1: "a critical one in a
// reachable component blocks stable"). Ratings: 0 none, 0.1 to 3.9 low, 4.0 to 6.9
// medium, 7.0 to 8.9 high, 9.0 to 10.0 critical. A v4.0 vector is not scored here: its
// score comes from a lookup over macro vectors, and advisories carrying one also carry the
// database's own rating, which is used instead.

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** v3.1's Roundup: the smallest number, to one decimal, at or above the input, free of floating-point error. */
function roundUp31(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

const roundUp30 = (value: number): number => Math.ceil(value * 10) / 10;

/** The base score of a CVSS:3.0 or CVSS:3.1 vector, or undefined for anything else or a vector missing a base metric. */
export function cvss3BaseScore(vector: string): number | undefined {
  const parts = vector.trim().split('/');
  const version = parts.shift();
  if (version !== 'CVSS:3.0' && version !== 'CVSS:3.1') return undefined;
  const metrics = new Map<string, string>();
  for (const part of parts) {
    const [key, value] = part.split(':');
    if (key === undefined || value === undefined || metrics.has(key)) return undefined;
    metrics.set(key, value);
  }
  const scope = metrics.get('S');
  const av = AV[metrics.get('AV') ?? ''];
  const ac = AC[metrics.get('AC') ?? ''];
  const ui = UI[metrics.get('UI') ?? ''];
  const c = CIA[metrics.get('C') ?? ''];
  const i = CIA[metrics.get('I') ?? ''];
  const a = CIA[metrics.get('A') ?? ''];
  const privileges = metrics.get('PR');
  const pr = privileges === 'N' ? 0.85 : privileges === 'L' ? (scope === 'C' ? 0.68 : 0.62) : privileges === 'H' ? (scope === 'C' ? 0.5 : 0.27) : undefined;
  if ((scope !== 'U' && scope !== 'C') || av === undefined || ac === undefined || ui === undefined || pr === undefined
    || c === undefined || i === undefined || a === undefined) return undefined;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0) return 0;
  const round = version === 'CVSS:3.1' ? roundUp31 : roundUp30;
  return round(Math.min(scope === 'U' ? impact + exploitability : 1.08 * (impact + exploitability), 10));
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export function ratingOf(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}
