import type { Flag } from './flags.render';

/**
 * Rendering §2 — the answer in sentences.
 *
 * ── THE RULE THE WHOLE LINEAGE GUARANTEE RESTS ON ─────────────────────────
 *
 * "Prose is assembled from the result, NEVER FROM THE MODEL'S RECOLLECTION of
 * the question. IF THE SENTENCE AND THE TABLE CAN DISAGREE, THE LINEAGE
 * GUARANTEE IS VOID. Prose generation reads the result object and nothing
 * else."
 *
 * So there is no model call in this file and there is nowhere to add one. An
 * answer written up by the model (129) is `reading.render`'s, and these fixed
 * sentences are what stands wherever that is not switched on. Every
 * figure in the output is read out of the result; the templates are fixed. A
 * model asked to summarise an answer produces a fluent paragraph containing
 * numbers that are close to right, and "close to right" in a figure somebody
 * acts on is worse than no figure at all.
 *
 * ── WHICH MEANS IT READS SLIGHTLY MECHANICALLY ────────────────────────────
 *
 * That is the trade, taken deliberately. A sentence that is always true is
 * worth more here than one that is always graceful.
 *
 * ── §2: "THE NUMBERS CANNOT DIFFER BETWEEN REPRESENTATIONS" ───────────────
 *
 * "All three from one result object… because there is only one set of numbers."
 * This function is given the same object the table is rendered from and the
 * same flags, so the guarantee is structural rather than a thing to check.
 */

export interface ProseAggregate {
  operation: string;
  fieldPath: string;
  value: number | null;
  /** Set when the arithmetic ran and the answer will not fit in a double. */
  overflowed?: boolean;
}

export interface ProseInput {
  conceptName: string;
  /** Every record the question matched — not the page of them an answer lists. */
  rowCount: number;
  /** What the first records are called, for naming them when there are only a few. */
  names?: string[];
  aggregates: ProseAggregate[];
  flags: Flag[];
  /** §5 — "the system, the field, the connector version", per source. */
  lineage: Array<{ connectionName: string; provider: string; manifestVersion: number }>;
  /**
   * Siloes (136) — what differs between two copies, where the question asked
   * what changed: per system, by the name people gave it. The records matched
   * are then the ones that differ, and the first sentence says so.
   */
  changes?: {
    fields?: string[];
    systems: Array<{
      name: string;
      from: string;
      to: string;
      added: number;
      removed: number;
      changed: number;
      fields: Array<{ fieldPath: string; records: number }>;
    }>;
  };
}

export interface Prose {
  sentences: string[];
  /**
   * §2 — "figures carrying inline lineage". One entry per source that
   * contributed, in the words a reader sees beside the figure.
   */
  attribution: string[];
  /**
   * True when something in the answer is incomplete or unsettled.
   *
   * THE CALLER CANNOT HIDE IT, because the qualifying sentences are already in
   * `sentences`. This is for deciding how loudly to say so, not whether to.
   */
  qualified: boolean;
}

const OPERATION_WORD: Record<string, string> = {
  sum: 'total',
  count: 'count',
  avg: 'average',
  min: 'lowest',
  max: 'highest',
};

/* Records named in the sentence, when a question matched no more than this. */
const NAMED = 5;

/**
 * "company" → "companies", "invoice" → "invoices", "contacts" stays. A concept
 * named after a system's object can arrive singular or plural, and "3 companys"
 * or "3 contactss" is the sentence telling the reader it was not written by
 * anybody.
 */
export function plural(word: string): string {
  const lower = word.toLowerCase();
  if (/[^s]s$/.test(lower) || /ies$/.test(lower)) return lower;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/** "A, B and C". */
const listed = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** A figure a person reads, not a float. Thousands separated, no trailing noise. */
function figure(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-GB') : value.toFixed(2);
}

export function proseOf(input: ProseInput): Prose {
  const sentences: string[] = [];

  /*
   * §4.4's floor has a prose equivalent: an answer with no rows is an ANSWER,
   * not an error and not an empty state. Somebody asked a real question and the
   * true reply is that nothing matched it.
   */
  const one = input.conceptName.toLowerCase();
  const many = plural(input.conceptName);
  const names = (input.names ?? []).filter(Boolean);

  /* A day, as a person says it: the copies compared are a day apart at least, so the hour is noise. */
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  if (input.changes) {
    /*
     * WHAT CHANGED IS SAID AS WHAT CHANGED. "11 deals matched" would be true
     * and would say nothing; the counts are the answer, they are exact, and
     * they are over every record of both copies — not the ones listed.
     */
    const watched = input.changes.fields?.length ? ` in ${listed(input.changes.fields)}` : '';
    sentences.push(
      input.rowCount === 0
        ? `No ${many} changed${watched}.`
        : `${figure(input.rowCount)} ${input.rowCount === 1 ? one : many} ${input.changes.fields?.length ? `changed${watched}` : 'are new or changed'}.`,
    );

    for (const system of input.changes.systems) {
      const most = system.fields.slice(0, 5).map((field) => `${field.fieldPath} (${figure(field.records)})`);
      sentences.push(
        `In ${system.name}, between the copy of ${day(system.from)} and the copy of ${day(system.to)}: ` +
          `${figure(system.added)} new, ${figure(system.changed)} changed, ${figure(system.removed)} gone.` +
          (most.length > 0 ? ` Changed in most records: ${most.join(', ')}.` : ''),
      );
    }
  } else if (input.rowCount === 0) {
    sentences.push(`No ${many} matched that question.`);
  } else if (input.rowCount <= NAMED && names.length === input.rowCount) {
    /* A handful is said by name: "3 companies matched: Acme, Globex and Initech." */
    sentences.push(`${figure(input.rowCount)} ${input.rowCount === 1 ? one : many} matched: ${listed(names)}.`);
  } else {
    sentences.push(`${figure(input.rowCount)} ${input.rowCount === 1 ? one : many} matched.`);
  }

  for (const aggregate of input.aggregates) {
    const word = OPERATION_WORD[aggregate.operation] ?? aggregate.operation;

    if (aggregate.overflowed) {
      /* Different from "nothing to count", and saying so beats a figure that
         silently wrapped. */
      sentences.push(
        `The ${word} of ${aggregate.fieldPath} is too large to state exactly.`,
      );
      continue;
    }

    if (aggregate.value === null) {
      /* A sum of nothing is not nought, and reporting it as nought would be a
         figure somebody could act on. */
      sentences.push(`There was nothing to take the ${word} of ${aggregate.fieldPath} over.`);
      continue;
    }

    sentences.push(`The ${word} of ${aggregate.fieldPath} is ${figure(aggregate.value)}.`);
  }

  /*
   * §6 — "all three must be visible in every representation", and prose is a
   * representation. So the flags are SENTENCES, in the same list as the
   * figures.
   *
   * THE QUALIFICATION IS NOT A FOOTNOTE. A caveat in smaller text below the
   * number is a caveat that gets screenshotted off, and the figure travels
   * without it. In the same breath is the only place it survives.
   */
  for (const flag of input.flags) sentences.push(flag.summary);

  return {
    sentences,
    /* §2 — "figures carrying inline lineage": which system, read through which
       version of its description. §4.2 of Recognition calls the version the
       element every figure was missing. */
    attribution: input.lineage.map(
      (source) => `${source.connectionName} (${source.provider}, connector v${source.manifestVersion})`,
    ),
    qualified: input.flags.length > 0,
  };
}
