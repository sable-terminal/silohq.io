/**
 * Recognising a restatement of a question already paid for.
 *
 * THE COMMERCIAL PROMISE IS THAT A REPHRASE CHARGES ONCE. Somebody who asks
 * "what did we spend with Acme" and then "total spend, Acme, this year" is
 * clarifying, not asking twice — and a meter that charges for both teaches people
 * to be careful rather than curious, which is the opposite of what this product
 * needs.
 *
 * DELIBERATELY GENEROUS. A false positive costs one compile. A false negative
 * costs trust, and appears on an invoice the customer disputes. The window and
 * threshold are set to favour not charging.
 */

const WINDOW_MS = 10 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.6;

export interface PriorCompile {
  question: string;
  compiledAt: Date;
  /** So a rephrase can be attributed to the compile it is a restatement of. */
  correlationId: string;
}

/**
 * Words carrying no discriminating signal.
 *
 * Removed before comparison, because two questions about entirely different
 * things share most of their small words. Without this, "what did we spend with
 * Acme" and "what did we sell to Beta" look similar.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'have', 'has', 'had', 'what', 'which', 'who', 'whom',
  'how', 'much', 'many', 'we', 'us', 'our', 'i', 'me', 'my', 'to', 'of', 'in',
  'on', 'for', 'with', 'at', 'by', 'from', 'this', 'that', 'these', 'those',
  'show', 'list', 'get', 'find', 'tell',
]);

export function tokenise(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/**
 * Jaccard similarity: shared terms over total distinct terms.
 *
 * CHOSEN OVER EDIT DISTANCE BECAUSE WORD ORDER DOES NOT MATTER HERE. "Acme spend
 * this year" and "this year's spend with Acme" are the same question and are far
 * apart by character distance.
 */
export function similarity(a: string, b: string): number {
  const left = tokenise(a);
  const right = tokenise(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;

  return shared / (left.size + right.size - shared);
}

export interface RephraseMatch {
  isRephrase: boolean;
  of?: PriorCompile;
  score?: number;
}

export function detect(
  question: string,
  priors: readonly PriorCompile[],
  now = new Date(),
): RephraseMatch {
  let best: { prior: PriorCompile; score: number } | null = null;

  for (const prior of priors) {
    if (now.getTime() - prior.compiledAt.getTime() > WINDOW_MS) continue;

    const score = similarity(question, prior.question);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { prior, score };
    }
  }

  return best ? { isRephrase: true, of: best.prior, score: best.score } : { isRephrase: false };
}
