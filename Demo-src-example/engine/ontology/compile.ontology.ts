import type { ConceptVocabulary } from './vocabulary.ontology';
import { valueFits, type Comparison } from '../execution/query.execution';

/**
 * §7.2 — what the model returned, checked against what was actually offered.
 *
 * ── Two passes, because they catch different failures ──────────────────────
 *
 * SHAPE first: is this the JSON a plan is made of. That catches a model that
 * returned prose, or an array where an object belongs, or a filter with no
 * operator. It is mechanical and a schema does it.
 *
 * TRUTH second: does every name in it exist in the vocabulary this reader was
 * given. That is the one that catches a CONFIDENTLY WRONG plan — a perfectly
 * shaped query naming `margin` on a concept that has no such field, or an `in`
 * filter against a source that declared it cannot push one down. A plan can be
 * flawless JSON and still be about a field nobody has.
 *
 * ── Rejected, never repaired ───────────────────────────────────────────────
 *
 * The same rule `draftManifest` and `ranking.validate` follow. A repaired plan
 * is a question nobody asked, executed against somebody's production systems
 * and returned as though they had. A model that gets it wrong twice should
 * produce a refusal rather than a third attempt against a shrinking budget.
 *
 * ── Ambiguity is an outcome, not a failure ─────────────────────────────────
 *
 * "Orders" where two concepts could match is not a bad question. Picking one
 * silently is how somebody gets a confident answer about the wrong thing, and
 * it is invisible: the figures are real, they are simply about something else.
 * So the compiler may return a CHOICE, and the caller asks.
 */

export type CompiledFilter = { field: string; op: Comparison; value?: unknown };

/**
 * §7.3 — a period, as the asker said it and as the plan will mean it.
 *
 * THE WORDS ARE CARRIED, NOT THE DATES. The model is not told what day it is
 * and must not be: a model asked to turn "last quarter" into two dates does it
 * from its training-era notion of now, confidently and silently. So it names
 * the PHRASE and the field, and `resolvePeriod` turns that into instants
 * against the organisation's own calendar at the moment the question runs.
 *
 * A saved view re-running then still means "last quarter" rather than being
 * frozen to one quarter forever, and the answer can say which quarter it took
 * them to mean.
 */
export type CompiledPeriod = {
  /** What the asker said: "last quarter", "since 2026-01-01". */
  expression: string;
  /** Which of the concept's declared time fields it applies to. */
  field: string;
};

/**
 * §4.1 — a condition on a concept's records by ANOTHER kind of record.
 *
 * "Customers that have an overdue invoice" is not a filter on a customer's
 * fields; it is a statement about invoices, and which customer each belongs
 * to. `exists: false` is the ones with none.
 *
 * `as` and `total` put a figure on each record kept — how many related records
 * reach it, or what one of their fields comes to — which then sorts and totals
 * like any field: "the five customers who owe most" is a sum of invoices, per
 * customer, sorted.
 *
 * ONE CONDITION DEEP. A related condition may carry one of its own ("open
 * deals of customers with overdue invoices") and no further.
 */
export type CompiledRelated = {
  conceptId: string;
  where: CompiledFilter[];
  exists: boolean;
  as?: string;
  total?: { operation: 'count' | 'sum'; field?: string };
  related?: CompiledRelated[];
};

/** §7 — something to work out over every matched record. Checked like any clause; computed by `analyse.ontology`. */
export type CompiledAnalysis =
  | { kind: 'breakdown'; by: string; measure: { operation: (typeof OPERATIONS)[number]; field?: string }; top?: number; order?: 'asc' | 'desc' }
  | { kind: 'trend'; time: string; every: 'day' | 'month' | 'quarter' | 'year'; measure: { operation: (typeof OPERATIONS)[number]; field?: string } }
  | { kind: 'crosstab'; by: [string, string]; measure: { operation: (typeof OPERATIONS)[number]; field?: string } };

export type CompiledPlan = {
  conceptId: string;
  period?: CompiledPeriod;
  select: string[];
  where: CompiledFilter[];
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number;
  aggregate: Array<{ operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum'; field: string }>;
  /**
   * A criterion no field holds, in the asker's words: "sells into defence",
   * "is a competitor", "is based in the north". The records are read without
   * it and it is judged afterwards, from public sources, in the write-up —
   * never refused because the records do not say it themselves.
   */
  judge?: string;
  /** §4.1 — conditions by other kinds of record. Every one must hold. */
  related?: CompiledRelated[];
  /** Held, or not held, in one of the concept's systems, by the system's name. */
  held?: Array<{ system: string; present: boolean }>;
  /** §7 — exact figures to work out over every matched record. */
  analyse?: CompiledAnalysis[];
  /**
   * Siloes (136) — as the records stood at a past moment, in the asker's own
   * words: "the end of last quarter" is `last quarter`, and the moment is the
   * close of whatever span the words name.
   *
   * THE WORDS, NOT A DATE, for the reason a period carries words. Whether there
   * is a copy from then is not something a plan can know; where there is none
   * the question is refused, in words that say what there is.
   */
  asAt?: { expression: string };
  /**
   * Siloes (136) — only the records that differ from how they stood at a past
   * moment: the start of whatever span `since` names. With `fields`, only
   * those in which one of them changed.
   */
  changed?: { since: string; fields?: string[] };
};

export type Compiled =
  | { outcome: 'plan'; plan: CompiledPlan }
  /**
   * One question, several concepts: "what is in my HubSpot", "give me an
   * overview". Each plan is checked exactly as a single one is, and one bad
   * plan rejects them all — a survey missing a part it was asked for reads as
   * complete.
   */
  | { outcome: 'plans'; plans: CompiledPlan[] }
  /**
   * The question is not about the organisation's records at all — a
   * definition, a benchmark, a public fact. Answerable only from outside, and
   * only when the asker has let the Console look there.
   */
  | { outcome: 'outside' }
  /**
   * Conversation, not a question: "hello", "thanks", "what can you do". Said
   * back in words from the names the model was shown — never a figure, because
   * it has none — and nothing is read.
   */
  | { outcome: 'reply'; text: string }
  /**
   * The words ask for data to be changed, not read. The Console has one box,
   * so the model that reads a question is also the one that notices a change
   * request — and hands it to the change compiler rather than planning a read.
   */
  | { outcome: 'change' }
  /** The model could not answer from the vocabulary, and said why. */
  | { outcome: 'refused'; reason: string }
  /**
   * Several things could be meant. The caller asks rather than guessing.
   *
   * AN OPTION HAS TO BE DISTINGUISHABLE FROM THE OTHERS. Where the choice is
   * between two DATES on one concept, every option carries the same concept id
   * — so a clarification that offered only ids was a question nobody could
   * answer, and the ask cost a model call to produce a dead end.
   */
  | {
      outcome: 'ambiguous';
      question: string;
      options: Array<{ conceptId: string; name: string; timeField?: string }>;
    }
  /** The model's output was not usable. Never repaired. */
  | { outcome: 'rejected'; reason: string; detail?: Record<string, unknown> };

const OPERATIONS = ['count', 'sum', 'average', 'minimum', 'maximum'] as const;

const COMPARISONS: Comparison[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null',
];

/**
 * Which aggregate operations a concept can answer at all.
 *
 * ── Push-down is not the same question as answerable ───────────────────────
 *
 * `capabilities.aggregates` declares only `count`, `sum` and `group_by`, so
 * `average`, `minimum` and `maximum` can never be pushed down today. That does
 * not make them unanswerable: the rows come back and the arithmetic happens
 * here, under the existing row bound.
 *
 * AVERAGE DECOMPOSES AND MIN/MAX DO NOT NEED TO. A mean is a sum over a count
 * and both compose across sources; a minimum of minima is a minimum. So every
 * operation is offerable — what changes is whether it costs a scan, and the
 * bound is what refuses when it does.
 */
const ANSWERABLE = OPERATIONS;

/**
 * Check what the model returned against what it was offered.
 *
 * `raw` IS WHATEVER CAME BACK OVER THE WIRE. It is parsed here rather than
 * trusted, and a parse failure is a rejection like any other — a model that
 * returns prose has not produced a plan, however reasonable the prose.
 */
export function validateCompiled(
  raw: unknown,
  vocabulary: readonly ConceptVocabulary[],
): Compiled {
  const body = parse(raw);
  if (!body) return { outcome: 'rejected', reason: 'The model did not return a plan.' };

  /* A refusal is a legitimate answer and is taken at face value — the model
     saying it cannot answer from this vocabulary is information. */
  if (typeof body.refusal === 'string' && body.refusal.trim() !== '') {
    return { outcome: 'refused', reason: body.refusal.trim() };
  }

  if (body.change === true) return { outcome: 'change' };

  if (body.outside === true) return { outcome: 'outside' };

  if (typeof body.reply === 'string' && body.reply.trim() !== '') {
    return { outcome: 'reply', text: body.reply.trim().slice(0, 2000) };
  }

  if (body.ambiguous) return ambiguity(body.ambiguous, vocabulary);

  if (body.plans !== undefined) return several(body.plans, vocabulary);

  return planOf(body, vocabulary);
}

/**
 * The most concepts one question may plan across.
 *
 * A BOUND, NOT A PREFERENCE. Each plan is a read of somebody's production
 * systems, and an overview of an estate with forty concepts is forty reads for
 * one question — which is a question to narrow, not to run.
 */
export const MOST_PLANS = 8;

function several(raw: unknown, vocabulary: readonly ConceptVocabulary[]): Compiled {
  const listed = objects(raw, 'plans');
  if (isBad(listed)) return { outcome: 'rejected', reason: listed.bad };
  if (listed.length === 0) return { outcome: 'rejected', reason: 'The model returned no plans.' };
  if (listed.length > MOST_PLANS) {
    return {
      outcome: 'rejected',
      reason: `That question reaches ${listed.length} kinds of record at once. Ask about fewer, at most ${MOST_PLANS}.`,
    };
  }

  const plans: CompiledPlan[] = [];
  for (const entry of listed) {
    const checked = planOf(entry, vocabulary);
    /* One part rejected, or asking which date it meant, stops the whole survey. */
    if (checked.outcome !== 'plan') return checked;
    plans.push(checked.plan);
  }

  /*
   * THE SAME CONCEPT TWICE IS ONE PART. A model listing Contact twice with
   * different filters has made one question into two that look like a survey.
   */
  const seen = new Set<string>();
  const distinct = plans.filter((plan) => (seen.has(plan.conceptId) ? false : (seen.add(plan.conceptId), true)));

  return distinct.length === 1 ? { outcome: 'plan', plan: distinct[0]! } : { outcome: 'plans', plans: distinct };
}

/** One plan, checked against what it was offered. */
function planOf(body: Record<string, unknown>, vocabulary: readonly ConceptVocabulary[]): Compiled {

  /* ── Pass one: shape ─────────────────────────────────────────────────── */

  const conceptId = body.conceptId;
  if (typeof conceptId !== 'string' || conceptId.trim() === '') {
    return { outcome: 'rejected', reason: 'The plan names no concept.' };
  }

  /* ── Pass two: truth ─────────────────────────────────────────────────── */

  const concept = vocabulary.find((one) => one.conceptId === conceptId);
  if (!concept) {
    /*
     * THE HALLUCINATION CASE, and the reason the second pass exists. A concept
     * id nobody offered is a plan about something this reader cannot see —
     * which is either invention or a memory of another tenant's estate, and
     * both are refused identically.
     */
    return {
      outcome: 'rejected',
      reason: 'The plan names a concept that was not offered.',
      detail: { conceptId },
    };
  }

  /*
   * THE OTHER CLAUSES FIRST, because a related condition can put a figure on
   * each record under a name of its own, and that name is then a field the
   * plan may select, sort on, total or break down by.
   */
  const related = relatedOf(body.related, concept, vocabulary, 0);
  if (isBad(related)) return { outcome: 'rejected', reason: related.bad, detail: { conceptId } };

  const known = new Set([...concept.fields, ...related.flatMap((one) => (one.as ? [one.as] : []))]);

  const held = heldOf(body.held, concept);
  if (isBad(held)) return { outcome: 'rejected', reason: held.bad, detail: { conceptId } };

  const analyse = analysisOf(body.analyse, concept, known);
  if (isBad(analyse)) return { outcome: 'rejected', reason: analyse.bad, detail: { conceptId } };

  const past = pastOf(body, concept);
  if (isBad(past)) return { outcome: 'rejected', reason: past.bad, detail: { conceptId } };

  const select = strings(body.select, 'select');
  if (isBad(select)) return { outcome: 'rejected', reason: select.bad };

  const unknownSelect = select.filter((field) => !known.has(field));
  if (unknownSelect.length > 0) {
    return {
      outcome: 'rejected',
      reason: `The plan selects ${unknownSelect.join(' and ')}, which ${concept.name} does not have.`,
      detail: { fields: unknownSelect },
    };
  }

  const filters = objects(body.where, 'filters');
  if (isBad(filters)) return { outcome: 'rejected', reason: filters.bad };

  const where: CompiledFilter[] = [];
  for (const entry of filters) {
    const field = typeof entry.field === 'string' ? entry.field : '';
    const op = entry.op as Comparison;

    if (!known.has(field)) {
      return {
        outcome: 'rejected',
        reason: `The plan filters on ${field || '(nothing)'}, which ${concept.name} does not have.`,
        detail: { field },
      };
    }

    if (!COMPARISONS.includes(op)) {
      return { outcome: 'rejected', reason: `${String(entry.op)} is not a filter.`, detail: { field } };
    }

    /*
     * AND THE SOURCE HAS TO BE ABLE TO APPLY IT. The vocabulary carries the
     * intersection of what every contributing connection declared, so an
     * operator outside it is one the estate cannot push down — and `plan` would
     * refuse the query after the model had already been paid for.
     */
    if (!concept.filters.includes(op)) {
      return {
        outcome: 'rejected',
        reason: `Not every system holding ${concept.name} can filter with ${op}.`,
        detail: { field, op },
      };
    }

    /*
     * AND THE VALUE HAS TO MEAN SOMETHING UNDER THAT OPERATOR. Checked here
     * rather than at the source, because a mismatch reaching a driver is either
     * an error nobody can read or an empty result nobody can distinguish from a
     * genuine one.
     */
    const wrong = valueFits(op, entry.value);
    if (wrong) return { outcome: 'rejected', reason: wrong, detail: { field, op } };

    where.push(entry.value === undefined ? { field, op } : { field, op, value: entry.value });
  }

  const totals = objects(body.aggregate, 'aggregates');
  if (isBad(totals)) return { outcome: 'rejected', reason: totals.bad };

  const aggregate: CompiledPlan['aggregate'] = [];
  for (const entry of totals) {
    const field = typeof entry.field === 'string' ? entry.field : '';
    const operation = entry.operation as (typeof OPERATIONS)[number];

    if (!ANSWERABLE.includes(operation)) {
      return { outcome: 'rejected', reason: `${String(entry.operation)} is not an aggregate.` };
    }
    if (!known.has(field)) {
      return {
        outcome: 'rejected',
        reason: `The plan totals ${field || '(nothing)'}, which ${concept.name} does not have.`,
        detail: { field },
      };
    }

    aggregate.push({ operation, field });
  }

  /* ── The period, if the question mentioned one ───────────────────────── */

  const period = periodOf(body.period, concept);
  if (isBad(period)) {
    return { outcome: 'rejected', reason: period.bad, detail: { conceptId } };
  }
  if (period && 'ask' in period) {
    return { outcome: 'ambiguous', question: period.ask, options: period.options };
  }

  const orderings = objects(body.sort, 'orderings');
  if (isBad(orderings)) return { outcome: 'rejected', reason: orderings.bad };

  const sort: CompiledPlan['sort'] = [];
  for (const entry of orderings) {
    const field = typeof entry.field === 'string' ? entry.field : '';
    if (!known.has(field)) {
      return {
        outcome: 'rejected',
        reason: `The plan sorts on ${field || '(nothing)'}, which ${concept.name} does not have.`,
        detail: { field },
      };
    }
    /*
     * ── A REPAIR, IN THE FILE WHOSE HEADER SAYS IT NEVER REPAIRS ────────────
     *
     * Anything that was not exactly `desc` became `asc`. So a model answering
     * "DESC" — the spelling SQL uses — asked for the biggest and got the
     * smallest, silently, with every figure correct.
     */
    if (entry.direction !== undefined && entry.direction !== 'asc' && entry.direction !== 'desc') {
      return {
        outcome: 'rejected',
        reason: `${String(entry.direction)} is not a direction. Use asc or desc.`,
        detail: { field },
      };
    }

    sort.push({ field, direction: entry.direction === 'desc' ? 'desc' : 'asc' });
  }

  /*
   * ABSENT MEANS THE DEFAULT; PRESENT AND WRONG IS A REJECTION. `'5'` used to
   * fall through to a hundred, so a model that quoted its number got twenty
   * times the rows it asked for and nothing said so.
   */
  if (body.limit !== undefined && body.limit !== null) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1) {
      return { outcome: 'rejected', reason: `${String(body.limit)} is not a number of rows.` };
    }
  }

  const limit = typeof body.limit === 'number' ? Math.min(body.limit, 1000) : 100;

  if (body.judge !== undefined && body.judge !== null && typeof body.judge !== 'string') {
    return { outcome: 'rejected', reason: 'A criterion to judge must be words.' };
  }
  const judge = typeof body.judge === 'string' && body.judge.trim() !== '' ? body.judge.trim().slice(0, 300) : undefined;

  return {
    outcome: 'plan',
    plan: {
      conceptId,
      ...(period ? { period } : {}),
      select,
      where,
      sort,
      limit,
      aggregate,
      ...(judge ? { judge } : {}),
      ...(related.length > 0 ? { related } : {}),
      ...(held.length > 0 ? { held } : {}),
      ...(analyse.length > 0 ? { analyse } : {}),
      ...past,
    },
  };
}

/* ── Conditions by other records, by system, and what to work out ────────── */

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MOST_RELATED = 4;
const MOST_TABLES = 4;

/** A list of filters on one concept's fields, checked as a plan's own filters are. */
function filtersOn(raw: unknown, concept: ConceptVocabulary): CompiledFilter[] | Bad {
  const entries = objects(raw, 'filters');
  if (isBad(entries)) return entries;

  const fields = new Set(concept.fields);
  const where: CompiledFilter[] = [];

  for (const entry of entries) {
    const field = typeof entry.field === 'string' ? entry.field : '';
    const op = entry.op as Comparison;

    if (!fields.has(field)) return { bad: `The plan filters on ${field || '(nothing)'}, which ${concept.name} does not have.` };
    if (!COMPARISONS.includes(op)) return { bad: `${String(entry.op)} is not a filter.` };
    if (!concept.filters.includes(op)) return { bad: `Not every system holding ${concept.name} can filter with ${op}.` };

    const wrong = valueFits(op, entry.value);
    if (wrong) return { bad: wrong };

    where.push(entry.value === undefined ? { field, op } : { field, op, value: entry.value });
  }

  return where;
}

/**
 * The related conditions of a plan, checked.
 *
 * ── ONLY A JOIN THAT CAN RUN ──────────────────────────────────────────────
 *
 * The related concept has to be one that was offered AND one a declared key
 * relates to this one — the vocabulary lists them. A join between two kinds of
 * record nothing relates is the model inventing a relationship, and is
 * rejected here rather than refused after everything was read.
 */
function relatedOf(
  raw: unknown,
  concept: ConceptVocabulary,
  vocabulary: readonly ConceptVocabulary[],
  depth: number,
): CompiledRelated[] | Bad {
  const entries = objects(raw, 'related conditions');
  if (isBad(entries)) return entries;
  if (entries.length > MOST_RELATED) return { bad: `A plan takes at most ${MOST_RELATED} related conditions.` };

  const names = new Set<string>();
  const out: CompiledRelated[] = [];

  for (const entry of entries) {
    const other = vocabulary.find((one) => one.conceptId === entry.conceptId);
    if (!other) return { bad: 'A related condition names a concept that was not offered.' };
    if (!concept.links.some((link) => link.conceptId === other.conceptId)) {
      return { bad: `Nothing in the systems relates ${other.name} to ${concept.name}.` };
    }

    const where = filtersOn(entry.where, other);
    if (isBad(where)) return where;

    if (entry.exists !== undefined && typeof entry.exists !== 'boolean') return { bad: 'Whether related records must exist is true or false.' };
    const exists = entry.exists !== false;

    let as: string | undefined;
    let total: CompiledRelated['total'];

    if (exists && entry.as !== undefined && entry.as !== null) {
      if (typeof entry.as !== 'string' || !NAME.test(entry.as)) return { bad: 'The name of a worked-out figure is lower case letters, digits and underscores.' };
      if (concept.fields.includes(entry.as) || names.has(entry.as)) return { bad: `${entry.as} is already a field of ${concept.name}.` };
      as = entry.as;
      names.add(as);

      const asked = entry.total && typeof entry.total === 'object' ? (entry.total as Record<string, unknown>) : null;
      if (asked) {
        if (asked.operation !== 'count' && asked.operation !== 'sum') return { bad: 'A figure about related records is a count or a sum.' };
        if (asked.operation === 'sum') {
          if (typeof asked.field !== 'string' || !other.fields.includes(asked.field)) {
            return { bad: `A sum needs a field of ${other.name} to add up.` };
          }
          total = { operation: 'sum', field: asked.field };
        } else total = { operation: 'count' };
      }
    }

    let deeper: CompiledRelated[] = [];
    if (entry.related !== undefined && entry.related !== null) {
      if (depth > 0) return { bad: 'A related condition may carry one of its own, and no deeper.' };
      const inner = relatedOf(entry.related, other, vocabulary, depth + 1);
      if (isBad(inner)) return inner;
      deeper = inner;
    }

    out.push({
      conceptId: other.conceptId,
      where,
      exists,
      ...(as ? { as } : {}),
      ...(total ? { total } : {}),
      ...(deeper.length > 0 ? { related: deeper } : {}),
    });
  }

  return out;
}

/** Held, or not held, in systems the concept is actually held in. */
function heldOf(raw: unknown, concept: ConceptVocabulary): NonNullable<CompiledPlan['held']> | Bad {
  const entries = objects(raw, 'systems');
  if (isBad(entries)) return entries;

  const out: NonNullable<CompiledPlan['held']> = [];
  for (const entry of entries) {
    if (typeof entry.system !== 'string' || !concept.systems.includes(entry.system)) {
      return { bad: `${concept.name} is held in ${concept.systems.join(', ') || 'no named system'}, not in ${String(entry.system)}.` };
    }
    if (typeof entry.present !== 'boolean') return { bad: 'Whether a record is held in a system is true or false.' };
    out.push({ system: entry.system, present: entry.present });
  }
  return out;
}

/**
 * Siloes (136) — a past moment the plan asks about, and what it asks changed since one.
 *
 * ONLY THE SHAPE IS CHECKED HERE. Which words name a span of time is the
 * resolver's to say, against the organisation's calendar; whether a copy was
 * made near it is the query's, against what is kept.
 */
function pastOf(body: Record<string, unknown>, concept: ConceptVocabulary): Pick<CompiledPlan, 'asAt' | 'changed'> | Bad {
  const out: Pick<CompiledPlan, 'asAt' | 'changed'> = {};

  if (body.asAt !== undefined && body.asAt !== null) {
    const asked = parse(body.asAt);
    const expression = typeof asked?.expression === 'string' ? asked.expression.trim() : '';
    if (expression === '') return { bad: 'The moment the plan asks about names no time.' };
    out.asAt = { expression: expression.slice(0, 80) };
  }

  if (body.changed !== undefined && body.changed !== null) {
    const asked = parse(body.changed);
    const since = typeof asked?.since === 'string' ? asked.since.trim() : '';
    if (since === '') return { bad: 'A plan asking what changed must say since when.' };

    const fields: string[] = [];
    if (asked?.fields !== undefined && asked.fields !== null) {
      if (!Array.isArray(asked.fields)) return { bad: 'The fields whose change is asked about must be a list.' };
      for (const field of asked.fields) {
        if (typeof field !== 'string' || !concept.fields.includes(field)) {
          return { bad: `The plan asks what changed in ${String(field ?? '(nothing)')}, which ${concept.name} does not have.` };
        }
        if (!fields.includes(field)) fields.push(field);
      }
    }

    out.changed = { since: since.slice(0, 80), ...(fields.length > 0 ? { fields } : {}) };
  }

  return out;
}

/** What to work out over every matched record, checked against the fields the plan can name. */
function analysisOf(raw: unknown, concept: ConceptVocabulary, known: ReadonlySet<string>): CompiledAnalysis[] | Bad {
  const entries = objects(raw, 'analyses');
  if (isBad(entries)) return entries;
  if (entries.length > MOST_TABLES) return { bad: `A plan works out at most ${MOST_TABLES} tables.` };

  const field = (value: unknown, what: string): string | Bad =>
    typeof value === 'string' && known.has(value) ? value : { bad: `The plan ${what} ${String(value ?? '(nothing)')}, which ${concept.name} does not have.` };

  const out: CompiledAnalysis[] = [];

  for (const entry of entries) {
    const asked = entry.measure && typeof entry.measure === 'object' ? (entry.measure as Record<string, unknown>) : {};
    const operation = (asked.operation ?? 'count') as (typeof OPERATIONS)[number];
    if (!OPERATIONS.includes(operation)) return { bad: `${String(asked.operation)} is not something to measure.` };

    let measure: CompiledAnalysis['measure'] = { operation };
    if (operation !== 'count' || asked.field !== undefined) {
      const measured = field(asked.field, 'measures');
      if (isBad(measured)) return measured;
      measure = { operation, field: measured };
    }

    if (entry.kind === 'breakdown') {
      const by = field(entry.by, 'breaks down by');
      if (isBad(by)) return by;
      if (entry.top !== undefined && (typeof entry.top !== 'number' || !Number.isInteger(entry.top) || entry.top < 1 || entry.top > 100)) {
        return { bad: 'How many groups to keep is a whole number from 1 to 100.' };
      }
      if (entry.order !== undefined && entry.order !== 'asc' && entry.order !== 'desc') return { bad: `${String(entry.order)} is not an order. Use asc or desc.` };
      out.push({ kind: 'breakdown', by, measure, ...(typeof entry.top === 'number' ? { top: entry.top } : {}), ...(entry.order ? { order: entry.order as 'asc' | 'desc' } : {}) });
    } else if (entry.kind === 'trend') {
      const time = field(entry.time, 'follows over time');
      if (isBad(time)) return time;
      const every = entry.every ?? 'month';
      if (every !== 'day' && every !== 'month' && every !== 'quarter' && every !== 'year') return { bad: `${String(entry.every)} is not a period. Use day, month, quarter or year.` };
      out.push({ kind: 'trend', time, every, measure });
    } else if (entry.kind === 'crosstab') {
      const pair = Array.isArray(entry.by) ? entry.by : [];
      if (pair.length !== 2) return { bad: 'A cross-tab is of two fields.' };
      const first = field(pair[0], 'cross-tabs');
      if (isBad(first)) return first;
      const second = field(pair[1], 'cross-tabs');
      if (isBad(second)) return second;
      out.push({ kind: 'crosstab', by: [first, second], measure });
    } else {
      return { bad: `${String(entry.kind)} is not a kind of table. Use breakdown, trend or crosstab.` };
    }
  }

  return out;
}

/**
 * A choice, checked the same way a plan is.
 *
 * AN OPTION NOBODY OFFERED IS STILL A HALLUCINATION. A clarification listing a
 * concept this reader cannot see would disclose it by asking about it, which is
 * the disclosure the vocabulary exists to prevent.
 */
function ambiguity(raw: unknown, vocabulary: readonly ConceptVocabulary[]): Compiled {
  const body = parse(raw);
  const options_ = strings(body?.options, 'options');
  const ids = isBad(options_) ? [] : options_;

  const options = ids
    .map((id) => vocabulary.find((one) => one.conceptId === id))
    .filter((one): one is ConceptVocabulary => Boolean(one))
    .map((one) => ({ conceptId: one.conceptId, name: one.name }));

  if (options.length < 2) {
    return {
      outcome: 'rejected',
      reason: 'The model reported an ambiguity between fewer than two things it was offered.',
    };
  }

  const question =
    typeof body?.question === 'string' && body.question.trim() !== ''
      ? body.question.trim()
      : 'Which of these did you mean?';

  return { outcome: 'ambiguous', question, options };
}

/** Parse whatever came back, without trusting any of it. */
function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/**
 * ── THESE USED TO COERCE, AND COERCION WAS THE DEFECT ──────────────────────
 *
 * A `where` that was not an array became `[]`, and an entry that was not a
 * plain object was dropped. The loop that validates filters then iterated
 * NOTHING and the function still returned `outcome: 'plan'` — so a filtered
 * question ran unfiltered over the whole estate, the aggregate totalled all of
 * it, and `coverage` beside it reported the entire estate as counted, which
 * reads as a complete answer to the question that was asked.
 *
 * That is the worst class of failure this layer exists to prevent: figures that
 * are real, correctly totalled, and about the wrong rows. Silently narrowing
 * the plan is a REPAIR, and repairs are what the file header refuses.
 *
 * Absent stays absent — a plan with no `where` is a question with no filter —
 * but a `where` that is present and malformed is rejected.
 */
type Bad = { bad: string };
const isBad = (value: unknown): value is Bad =>
  typeof value === 'object' && value !== null && 'bad' in value;

const strings = (value: unknown, clause: string): string[] | Bad => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { bad: `${clause} is not a list.` };

  const wrong = value.find((one) => typeof one !== 'string');
  if (wrong !== undefined) return { bad: `${clause} contains something that is not a field name.` };

  return value as string[];
};

const objects = (value: unknown, clause: string): Array<Record<string, unknown>> | Bad => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { bad: `${clause} is not a list.` };

  const wrong = value.some(
    (one) => typeof one !== 'object' || one === null || Array.isArray(one),
  );
  if (wrong) return { bad: `${clause} contains something that is not a ${clause.slice(0, -1)}.` };

  return value as Array<Record<string, unknown>>;
};

/**
 * Which time field a period applies to, or a question back.
 *
 * ── THE CHOICE IS SURFACED, NOT MADE ───────────────────────────────────────
 *
 * An invoice raised in March, amended in April and dated to February falls in
 * three different quarters depending which field "last quarter" meant. Where a
 * concept declares one time field, or declares which is usual, that is the
 * answer. WHERE IT DECLARES SEVERAL AND NO DEFAULT, picking one silently is how
 * somebody gets a confident answer about the wrong months — so this asks, the
 * same treatment two concepts that could both be meant already get.
 */
function periodOf(
  raw: unknown,
  concept: ConceptVocabulary,
):
  | CompiledPeriod
  | null
  | Bad
  | { ask: string; options: Array<{ conceptId: string; name: string }> } {
  if (raw === undefined || raw === null) return null;

  const body = parse(raw);
  if (!body) return { bad: 'The period is not something this can read.' };

  const expression = typeof body.expression === 'string' ? body.expression.trim() : '';
  if (expression === '') return { bad: 'The period names no span of time.' };

  if (concept.timeFields.length === 0) {
    /*
     * NOTHING IS DECLARED A TIME, so there is no column to apply a range to.
     * Refused by name rather than answered over all of history, which would be
     * a real figure for the wrong span.
     */
    return { bad: `Nothing in ${concept.name} is declared to be a date, so it cannot be asked about a period.` };
  }

  const named = typeof body.field === 'string' ? body.field.trim() : '';

  if (named !== '') {
    const known = concept.timeFields.find((one) => one.fieldPath === named);
    if (!known) {
      return { bad: `${named} is not a date field on ${concept.name}.` };
    }
    return { expression, field: known.fieldPath };
  }

  const fallback =
    concept.timeFields.find((one) => one.isDefault) ??
    (concept.timeFields.length === 1 ? concept.timeFields[0] : undefined);

  if (fallback) return { expression, field: fallback.fieldPath };

  return {
    ask: `Which date should "${expression}" apply to?`,
    /*
     * THE OPTIONS ARE CONCEPT-SHAPED because that is what the caller renders,
     * and the field is what distinguishes them — same concept, different
     * meaning of "when".
     */
    options: concept.timeFields.map((one) => ({
      conceptId: concept.conceptId,
      name: `${concept.name} by ${one.fieldPath} (${one.kind})`,
      /* THE FIELD IS WHAT DISTINGUISHES THEM. Same concept, different meaning
         of "when", so the id alone cannot carry the answer back. */
      timeField: one.fieldPath,
    })),
  };
}
