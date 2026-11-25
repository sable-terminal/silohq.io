// Confidence bands per proposal kind, from measured acceptance (spec 52.3: "Band thresholds
// are per kind, set from measured acceptance (chapter 54)"), as a Beta-Binomial question
// (decision 2026-11-11) rather than fixed sample sizes.
//
// The evidence is the organisation's decided proposals of the kind, across its engagements.
// High starts at the lowest confidence c for which, among decided proposals at or above c, the
// chance that nine in ten or more are accepted unchanged is at least 95% (a uniform prior).
// Medium likewise for six in ten accepted, edited or not. Where no confidence earns a band, the
// fixed threshold (0.85 high, 0.6 medium) holds unless the evidence at it is strongly against
// it (under a 5% chance of the rate), in which case no proposal of the kind earns that band.
// So a kind with no decisions keeps the fixed bands; a kind people trust earns a lower
// threshold; a kind people keep rejecting loses the band. The rates and credibility are this
// build's choice: chapter 54 says thresholds come from acceptance, not which rates make a band.

import type { Queryable } from '../../infra/postgres.infra.ts';
import { fdeProposalRepo } from '../../repos/fde/index.repo.ts';
import { probabilityAbove } from '../../utils/bayes.util.ts';

export const FIXED_BANDS = { high: 0.85, medium: 0.6 } as const;
const HIGH_RATE = 0.9;
const MEDIUM_RATE = 0.6;
/** How sure the evidence must be to move a threshold, and how unlikely to withdraw a band. */
export const CREDIBILITY = 0.95;
const AGAINST = 0.05;
/** Above every confidence: the band is not earned. */
const UNEARNED = 1.001;

export type Band = 'high' | 'medium' | 'low';
export interface Thresholds { high: number; medium: number; measured: boolean }
type Decided = { confidence: number; status: string };

/** The threshold one band takes from the decided proposals (see the header). */
function threshold(decided: readonly Decided[], ok: (status: string) => boolean, rate: number, fixed: number): { at: number; measured: boolean } {
  const confidences = [...new Set(decided.map((d) => d.confidence))].sort((a, b) => b - a);
  let best: number | null = null;
  for (const c of confidences) {
    const above = decided.filter((d) => d.confidence >= c);
    if (probabilityAbove(rate, above.filter((d) => ok(d.status)).length, above.length) >= CREDIBILITY) best = c;
  }
  if (best !== null && best < fixed) return { at: best, measured: true };
  const atFixed = decided.filter((d) => d.confidence >= fixed);
  if (atFixed.length > 0 && probabilityAbove(rate, atFixed.filter((d) => ok(d.status)).length, atFixed.length) < AGAINST) {
    return { at: UNEARNED, measured: true };
  }
  // Evidence only above the fixed threshold says nothing against it: the fixed one holds.
  return { at: fixed, measured: false };
}

/** Thresholds from decided proposals of one kind (pure). */
export function thresholdsFrom(decided: readonly Decided[]): Thresholds {
  const high = threshold(decided, (s) => s === 'accepted', HIGH_RATE, FIXED_BANDS.high);
  const medium = threshold(decided, (s) => s === 'accepted' || s === 'accepted_edited', MEDIUM_RATE, FIXED_BANDS.medium);
  return { high: high.at, medium: Math.min(medium.at, high.at), measured: high.measured || medium.measured };
}

export function bandWith(confidence: number, thresholds: Pick<Thresholds, 'high' | 'medium'>): Band {
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.medium) return 'medium';
  return 'low';
}

/** The band of a new proposal of this kind, in the organisation's context. */
export async function bandFor(db: Queryable, kind: string, confidence: number): Promise<Band> {
  return bandWith(confidence, thresholdsFrom(await fdeProposalRepo.decidedOfKind(db, kind)));
}
