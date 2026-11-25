import { childLogger } from '../config/logger.config';
import { lookOutside } from '../infra/model.infra';
import { cite, type Source } from '../utils/citations.util';

const log = childLogger('outside');

/**
 * Context from outside the organisation's systems, and where each part of it
 * came from. Never merged into what a system returned: it travels beside an
 * answer, so nothing that lists, draws or traces the records can mistake it
 * for them.
 */
export type Outside = { paragraphs: string[]; sources: Source[] };

/**
 * What the web adds to a question, or nothing.
 *
 * ── THE QUESTIONS GO OUT, AND NOTHING ELSE ────────────────────────────────
 *
 * The question asked now and the ones typed before it — the asker's own words —
 * and, to fill what their records lack, the names of organisations an answer
 * read (`reading.render.subjectsOf`: organisations only, never people, never a
 * figure or an identifier). Never a reply and never a record. The first answer
 * and every follow-up about it look outside through here, so the rule has one
 * place to be true.
 *
 * NEVER THE REASON A QUESTION FAILS, AND NEVER UNSOURCED. A web lookup that errors, or a model that
 * cannot be reached, leaves the answer from the systems exactly as it was; the
 * outside was only ever context. `NONE` is the model saying nothing outside
 * would add to it.
 */
export async function outsideFor(
  question: string,
  earlier: string[],
  subjects: string[] = [],
  criteria: string[] = [],
): Promise<Outside | null> {
  try {
    const found = await lookOutside({
      question,
      earlier,
      ...(subjects.length ? { subjects } : {}),
      ...(subjects.length && criteria.length ? { criteria } : {}),
    });
    const text = found.ok ? (found.raw ?? '').trim() : '';
    if (!text || /^NONE\.?$/i.test(text)) return null;

    /*
     * NO SOURCE, NO USE. A lookup that answered from the model's memory rather
     * than from pages it found has nothing to cite, and web context that
     * cannot say where it came from is exactly what the Console promises never
     * to mix in.
     */
    const outside = cite(text, found.grounding);
    return outside.paragraphs.length > 0 && outside.sources.length > 0 ? outside : null;
  } catch (error) {
    log.info({ err: error }, 'Could not look outside the systems for this question');
    return null;
  }
}

/**
 * Web context found later, numbered on from what was already cited.
 *
 * A FOLLOW-UP'S SOURCES CONTINUE THE ANSWER'S. The write-up already says [1]
 * and [2]; a follow-up that found more says [3], so every number in the
 * conversation points at one page.
 */
export function numberedAfter(outside: Outside, already: readonly Source[]): Outside {
  const offset = already.reduce((most, source) => Math.max(most, source.n), 0);
  if (offset === 0) return outside;
  return {
    paragraphs: outside.paragraphs.map((paragraph) => paragraph.replace(/\[(\d+)\]/g, (_, n: string) => `[${Number(n) + offset}]`)),
    sources: outside.sources.map((source) => ({ ...source, n: source.n + offset })),
  };
}
