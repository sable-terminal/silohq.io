import { companyName, postcode } from './normalise.util';

/**
 * Deciding that two records in two systems are the same thing.
 *
 * MATCH KEYS ONLY. The entity graph holds hashes and identifiers, never the
 * business data itself — resolving `Acme` in the CRM to `Acme` in the ledger
 * needs to know they match, not what either row contains.
 *
 * CONFIDENCE, NOT A BOOLEAN. A registration number matching is near-certain; two
 * companies with similar names at the same postcode is likely; similar names
 * alone is a guess. Collapsing that into true/false means either merging things
 * that are different or missing things that are the same, and which one you get
 * depends on where somebody put the threshold.
 *
 * NOTHING IS AUTO-MERGED BELOW CERTAINTY. A weak match is surfaced for a human,
 * because a wrongly merged supplier is a figure that is wrong in a way nobody can
 * see — the total is plausible and the constituents are invisible.
 */

export interface EntityRecord {
  connectionId: string;
  externalId: string;
  name?: string | null;
  registrationNumber?: string | null;
  taxId?: string | null;
  postcode?: string | null;
  email?: string | null;
  domain?: string | null;
}

export type MatchStrength = 'certain' | 'strong' | 'probable' | 'weak' | 'none';

export interface Match {
  strength: MatchStrength;
  score: number;
  /** Which signals agreed. Shown to whoever confirms a non-certain match. */
  signals: string[];
}

/**
 * Weights.
 *
 * IDENTIFIERS BEAT NAMES BY AN ORDER OF MAGNITUDE. A company registration number
 * is issued by a registrar and is unique by construction; a name is typed by
 * whoever created the record. Two suppliers genuinely called "Smith Construction"
 * exist; two with the same registration number do not.
 */
const WEIGHTS = {
  registrationNumber: 100,
  taxId: 100,
  domain: 40,
  email: 35,
  postcode: 20,
  nameExact: 30,
  nameSimilar: 15,
} as const;

/**
 * Normalised edit distance, 0 to 1.
 *
 * Levenshtein on short strings, which is what company names are. It is O(n·m) and
 * that is fine for two names; it would not be for two documents.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }

  const distance = previous[cols - 1]!;
  return 1 - distance / Math.max(a.length, b.length);
}

export function compare(left: EntityRecord, right: EntityRecord): Match {
  const signals: string[] = [];
  let score = 0;

  /*
   * AN IDENTIFIER MATCH IS DECISIVE AND RETURNS IMMEDIATELY. Once two records
   * share a registration number, a different name is a rename or a typo — not
   * evidence against. Continuing to score would let a name mismatch drag a
   * certain match down to probable.
   */
  if (left.registrationNumber && left.registrationNumber === right.registrationNumber) {
    return { strength: 'certain', score: WEIGHTS.registrationNumber, signals: ['registration number'] };
  }
  if (left.taxId && left.taxId === right.taxId) {
    return { strength: 'certain', score: WEIGHTS.taxId, signals: ['tax id'] };
  }

  if (left.domain && right.domain && left.domain.toLowerCase() === right.domain.toLowerCase()) {
    score += WEIGHTS.domain;
    signals.push('domain');
  }
  if (left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase()) {
    score += WEIGHTS.email;
    signals.push('email');
  }
  if (left.postcode && right.postcode && postcode(left.postcode) === postcode(right.postcode)) {
    score += WEIGHTS.postcode;
    signals.push('postcode');
  }

  if (left.name && right.name) {
    const a = companyName(left.name);
    const b = companyName(right.name);
    if (a && a === b) {
      score += WEIGHTS.nameExact;
      signals.push('name');
    } else {
      const ratio = similarity(a, b);
      if (ratio >= 0.85) {
        score += Math.round(WEIGHTS.nameSimilar * ratio);
        signals.push(`name ${Math.round(ratio * 100)}% similar`);
      }
    }
  }

  return { strength: strengthOf(score, signals), score, signals };
}

function strengthOf(score: number, signals: string[]): MatchStrength {
  if (score >= 100) return 'certain';
  if (score >= 60) return 'strong';
  // A single weak signal is never more than a guess, however it scores. Two
  // suppliers at one business park share a postcode and nothing else.
  if (score >= 35 && signals.length >= 2) return 'probable';
  if (score > 0) return 'weak';
  return 'none';
}

/** Whether a match may be applied without a human confirming it. */
export function isAutoMergeable(match: Match): boolean {
  return match.strength === 'certain' || match.strength === 'strong';
}

/**
 * A stable key for the entity graph.
 *
 * BUILT FROM IDENTIFIERS WHERE THEY EXIST, AND NEVER FROM A NAME ALONE. A key
 * derived from a name changes when somebody fixes a typo, which orphans every
 * relationship pointing at it.
 */
export function matchKey(record: EntityRecord): string | null {
  if (record.registrationNumber) return `reg:${record.registrationNumber.toUpperCase()}`;
  if (record.taxId) return `tax:${record.taxId.toUpperCase()}`;
  if (record.domain) return `dom:${record.domain.toLowerCase()}`;
  return null;
}
