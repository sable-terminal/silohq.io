import { withTransaction } from '../infra/db.infra';
import { connectionCapabilities } from '../engine/read/capabilities.read';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, refusal } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { readableIds } from './connector.service';
import { askPlanned, type ConceptAnswer } from './conceptQuery.service';
import { ensureSystemConcepts } from './concept.service';
import { recordConnectorUse } from './map.service';
import * as tokens from './tokens.service';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import * as conceptRepo from '../repos/concept.repo';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import { withLearned } from '../engine/ontology/derive.ontology';
import * as connectorRepo from '../repos/connector.repo';
import * as authzRepo from '../repos/authz.repo';
import * as conceptTimeRepo from '../repos/conceptTime.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as webRepo from '../repos/webContext.repo';
import {
  DEFAULT_CALENDAR,
  isPeriod,
  resolvePeriod,
  resolveMoment,
  isMoment,
  type Calendar,
} from '../engine/ontology/period.ontology';
import { checkMarkings } from '../utils/markingCheck.util';
import { compile as askModel, isConfigured, ModelUnavailable } from '../infra/model.infra';
import type { Source } from '../utils/citations.util';
import { outsideFor, type Outside } from './outside.service';
import {
  describeVocabulary,
  vocabularyOf,
  type Capability,
  type ConceptVocabulary,
} from '../engine/ontology/vocabulary.ontology';
import { MOST_PLANS, validateCompiled, type Compiled, type CompiledPlan } from '../engine/ontology/compile.ontology';
import type { Actor } from './scope.service';

const log = childLogger('compile');

/**
 * §7 — a question in plain English, turned into a plan and executed.
 *
 * ── The stage every other one has been waiting for ─────────────────────────
 *
 * Ten comments across this codebase refer to "the compiler" as something that
 * will exist. It never has: `model.infra.compile` was written and called by
 * nothing, so a caller had to name a raw object and know that Sage calls it
 * `TBL_INV_H` — which is the exact knowledge the ontology exists to remove.
 * Concepts were used by detectors and by nothing anybody queried through.
 *
 * ── The ordering is the guarantee ──────────────────────────────────────────
 *
 * The vocabulary is resolved BEFORE the model runs, from what this reader can
 * actually see. A concept they hold no grant on, or no clearance for, is not in
 * it — so a plan cannot name one, because the model was never told it existed.
 *
 * That is a stronger guarantee than filtering a plan afterwards. Post-filtering
 * leaves the model free to compose a question around something it should not
 * know about, and the refusal that follows tells the reader the thing is there.
 * Here, omission is the mechanism.
 *
 * ── The model plans; it never reads ────────────────────────────────────────
 *
 * `model.infra` states it: no model runs in the query path, and it never sees a
 * result, a row, or a figure. What it receives is names — concepts, fields, and
 * what each source declares it can push down. What it returns is structure.
 * Everything after that is deterministic and traceable, which is the difference
 * between an answer somebody can check and one that sounds right.
 */

/** One concept's part of an answer: the plan, what it read, and the dates it took a period to mean. */
export type AnsweredPart = {
  plan: CompiledPlan;
  answer: ConceptAnswer;
  /**
   * §7.3 — which period the answer actually covers.
   *
   * BOTH HALVES, DELIBERATELY. The words alone cannot be checked against
   * the figures, and the instants alone are not recognisable as what was
   * asked. A person handed "£4.2m for last quarter" is owed the two dates
   * that were used, because their quarter may not be ours.
   */
  period?: { expression: string; from: Date; until: Date };
};

export type { Outside };

export type CompileOutcome =
  | ({ outcome: 'answered'; outside?: Outside } & AnsweredPart)
  /** One question across several concepts — "what is in my HubSpot". */
  | { outcome: 'surveyed'; parts: AnsweredPart[]; outside?: Outside }
  /** A question about nothing the systems hold, answered from outside them, with its sources. */
  | { outcome: 'general'; paragraphs: string[]; sources: Source[] }
  /** Conversation — a greeting, thanks, "what can you do" — answered in words. Nothing read, nothing charged. */
  | { outcome: 'replied'; text: string }
  | {
      outcome: 'refused';
      reason: string;
      /** Looking outside the systems could answer it, and the asker had not allowed that. */
      outsideWouldHelp?: boolean;
    }
  | {
      outcome: 'ambiguous';
      question: string;
      options: Array<{ conceptId: string; name: string; timeField?: string }>;
    }
  /** The words asked for a change; the caller hands them to the change compiler. Nothing is charged here. */
  | { outcome: 'change' };

/**
 * Ask a question.
 *
 * ── Charged after a plan exists, so a refusal costs nothing ────────────────
 *
 * The model call is the expensive part and it happens once. A question it
 * declines, or a plan that fails validation, is recorded as what it was and
 * does not reach anybody's production systems.
 */
export async function ask(
  actor: Actor,
  input: {
    question: string;
    history?: Array<{ role: 'user' | 'model'; text: string }>;
    /** Whether the asker let the Console look outside their systems for this question. */
    outside?: boolean;
  },
): Promise<CompileOutcome> {
  if (!isConfigured()) {
    throw refusal({
      message: 'No model is configured, so questions in plain English cannot be compiled.',
      code: 'refusal.model_unconfigured',
    });
  }

  /* ── Stage one: what this person can see ──────────────────────────────── */

  const { vocabulary, calendar, webOff } = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'query.run');

        /*
         * EVERY CONFIRMED OBJECT IS ASKABLE, whether or not anybody has built an
         * ontology over it (128). A connection confirmed before system concepts
         * existed gets them here, the first time anybody asks.
         */
        await ensureSystemConcepts(db, actor);
        const concepts = await conceptRepo.listLive(db);

        const readable = await readableIds(
          db,
          actor,
          [...new Set(concepts.flatMap((one) => one.objects.map((o) => o.connectionId)))],
        );

        /*
         * §2.5 — CLEARANCE DROPS A CONCEPT FROM THE VOCABULARY ENTIRELY. Not
         * from the plan afterwards: a marked concept the model was told about
         * is one it can compose a question around, and the refusal that follows
         * announces the compartment.
         */
        const visible: Array<{
          id: string;
          name: string;
          objects: typeof concepts[number]['objects'];
          superseded: Record<string, string>;
        }> = [];

        /* Field policy: the model is never told the name of a field this reader may not see. */
        const hidden = await hiddenFields(db, actor, [...readable]);

        /*
         * §2.3 (131) — what answers have taught about these systems' field
         * names. The model plans in the names a question will be read by, or a
         * plan naming the shared field would be refused as one the concept does
         * not have.
         */
        const learned = await fieldAliasRepo.learnedFor(db, [
          ...new Set(concepts.flatMap((one) => one.objects.map((object) => object.connectionId))),
        ]);

        for (const concept of concepts) {
          const required = await authzRepo.markingsOnResource(db, 'concept', concept.id);
          if (!checkMarkings({ required }, { held: authority.clearances }).permitted) continue;

          /* Over the whole concept, as `ask` reads it, and only then narrowed to what this reader reaches. */
          const read = withLearned({ objects: concept.objects, learned });

          visible.push({
            id: concept.id,
            name: concept.name,
            objects: visibleObjects(
              read.objects.filter((one) => readable.has(one.connectionId)),
              hidden,
            ),
            superseded: read.superseded,
          });
        }

        const connectionIds = [...new Set(visible.flatMap((c) => c.objects.map((o) => o.connectionId)))];
        const loaded = await connectorRepo.load(db, connectionIds);

        const capabilities = new Map<string, Capability>(
          loaded.map((connection) => [
            connection.connectionId,
            {
              filters: connectionCapabilities(connection.manifest).filters,
              aggregates: connectionCapabilities(connection.manifest).aggregates,
            },
          ]),
        );

        /*
         * §7.3 — WHICH FIELD A PERIOD WOULD APPLY TO. Told to the model rather
         * than guessed afterwards: a concept with several time fields and no
         * default is a question that cannot be answered without asking which
         * was meant, and the model can only ask if it knows there is a choice.
         */
        const times = await conceptTimeRepo.forConcepts(
          db,
          visible.map((one) => one.id),
        );

        const supersededIn = new Map(visible.map((one) => [one.id, one.superseded]));

        const byConcept = new Map<string, Array<{ fieldPath: string; kind: string; isDefault: boolean }>>();
        for (const field of times) {
          /*
           * A TIME FIELD DECLARED UNDER A NAME SINCE SUPERSEDED FOLLOWS IT.
           * The period then reaches every system that holds the date, rather
           * than only the one whose word for it somebody happened to declare.
           */
          const fieldPath = supersededIn.get(field.conceptId)?.[field.fieldPath] ?? field.fieldPath;
          const held = byConcept.get(field.conceptId) ?? [];
          if (held.some((one) => one.fieldPath === fieldPath)) continue;

          byConcept.set(field.conceptId, [...held, { fieldPath, kind: field.kind, isDefault: field.isDefault }]);
        }

        const organisation = await organisationRepo.findById(db, actor.organisationId);

        return {
          vocabulary: vocabularyOf({
            concepts: visible.map((one) => ({ ...one, superseded: Object.keys(one.superseded) })),
            capabilities,
            timeFields: byConcept,
            systemNames: new Map(loaded.map((connection) => [connection.connectionId, connection.name])),
            /* §4.1 — which concepts a declared key relates, so the model plans only joins that can run. */
            relationships: await conceptRepo.relationships(db),
          }),
          /* §7.3 — the calendar "last quarter" is measured against. A company
             whose year starts in April means something different by it than the
             calendar does, and being wrong looks entirely plausible. */
          calendar: organisation?.calendar ?? DEFAULT_CALENDAR,
          /* 130 — a super admin's "no web" for the organisation wins over the asker's switch. */
          webOff: (await webRepo.switchedOff(db)) !== null,
        };
      }),
  );

  /*
   * ── THE WEB ANSWERS ONLY WHAT THE SYSTEMS CANNOT BE ASKED ────────────────
   *
   * A question about the organisation's records is answered from them, and
   * the web only adds to that — in the write-up, where the organisations an
   * answer found are looked up. A lookup on the question's words alone ran
   * beside every question and, when the systems could not answer, stood in
   * for them: "find a contact in my CRM that sells into defence" came back
   * as a list of arms manufacturers. So the question's words go to the web
   * only when the model has said the question is about nothing any system
   * holds, and never in place of a refusal about the systems.
   */
  const earlier = (input.history ?? []).filter((turn) => turn.role === 'user').map((turn) => turn.text);
  const webAllowed = Boolean(input.outside) && !webOff;
  const fromOutside = () => (webAllowed ? outsideFor(input.question, earlier) : Promise.resolve(null));

  if (vocabulary.length === 0) {
    const outside = await fromOutside();
    if (outside) {
      await tokens.spend(actor, 'outside_context');
      return { outcome: 'general', ...outside };
    }
    return {
      outcome: 'refused',
      reason: 'There is nothing here you can ask about yet. Connect a system, and check what it reads.',
    };
  }

  /* ── Stage two: the model sees names, and the question ────────────────── */

  /*
   * Billing §4 — REFUSED BEFORE THE MODEL RUNS, CHARGED AFTER IT ANSWERS. The
   * check is for the most a compile can cost, because whether this question
   * reaches one system or several is not known until there is a plan; a refusal
   * or a rephrase then costs nothing, which §4 requires.
   */
  await tokens.afford(actor, 'multi_system_compile');

  const asked = new Date();

  /*
   * A MODEL THAT CANNOT BE REACHED IS A REFUSAL, NOT A FAULT. Credentials that
   * lapsed or a provider that is down is the deployment telling the person it
   * cannot compile right now — said plainly, like every other model-backed
   * feature says it, rather than as "something went wrong" and a 500.
   */
  let result: Awaited<ReturnType<typeof askModel>>;
  try {
    result = await askModel({
      question: input.question,
      schema: planShape(),
      ontology: [describeVocabulary(vocabulary), '', describeCalendar(calendar, asked)].join('\n'),
      history: input.history,
    });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      throw refusal({
        message: 'Questions in plain English need the model, and it cannot be reached right now. Try again shortly.',
        code: 'refusal.model_unavailable',
      });
    }
    throw error;
  }

  /* ── Stage three: validate, and reject rather than repair ─────────────── */

  const compiled: Compiled = result.ok
    ? validateCompiled(result.raw, vocabulary)
    : { outcome: 'refused', reason: result.refusal ?? 'The model declined to answer.' };

  await record(actor, input.question, compiled, result);

  if (compiled.outcome === 'rejected') {
    /*
     * REJECTED, NEVER REPAIRED, and never retried here. A model that gets it
     * wrong twice should produce a refusal rather than a third attempt against
     * a shrinking budget — and a repaired plan is a question nobody asked, run
     * against somebody's production systems and returned as though they had.
     */
    throw invalid({
      message: compiled.reason,
      code: 'invalid.plan_rejected',
      detail: compiled.detail ?? {},
    });
  }

  /*
   * A CHANGE REQUEST IS NOT A QUESTION, AND IS NOT CHARGED AS ONE. Like a
   * refusal, it produced no plan; the change compiler that takes the words
   * next charges if — and only if — a change comes of them.
   */
  if (compiled.outcome === 'change') return { outcome: 'change' };
  /*
   * "HELLO" IS NOT A QUESTION FOR THE SYSTEMS. It used to be planned as one —
   * or refused as one — which is the Console failing the first thing most
   * people type. Said back in words, free, like a refusal: nothing was read.
   */
  if (compiled.outcome === 'reply') return { outcome: 'replied', text: compiled.text };
  if (compiled.outcome === 'ambiguous') {
    return { outcome: 'ambiguous', question: compiled.question, options: compiled.options };
  }

  /*
   * A REFUSAL ABOUT THE SYSTEMS STAYS ONE. It is the model saying no concept
   * could hold what was asked about; the web does not get to answer a
   * different question in its place.
   */
  if (compiled.outcome === 'refused') return { outcome: 'refused', reason: compiled.reason };

  /* ── Not about the systems at all: answered from the web, or said plainly ─ */
  if (compiled.outcome === 'outside') {
    if (webOff) {
      return {
        outcome: 'refused',
        reason: 'That is not about anything your systems hold, and a super admin has switched off context from the web for your organisation.',
      };
    }
    if (!webAllowed) {
      return {
        outcome: 'refused',
        reason: 'That is not about anything your systems hold. Let the Console look outside them and ask again.',
        outsideWouldHelp: true,
      };
    }
    const outside = await fromOutside();
    if (!outside) return { outcome: 'refused', reason: 'Nothing in your systems or on the web answers that.' };
    await tokens.spend(actor, 'outside_context');
    return { outcome: 'general', ...outside };
  }

  /* ── Stage three and a half: each period, resolved here and not by a model ─ */

  const plans = compiled.outcome === 'plan' ? [compiled.plan] : compiled.plans;
  const bounded: Array<{
    plan: CompiledPlan;
    where: CompiledPlan['where'];
    period: AnsweredPart['period'];
    asAt?: Date;
    changed?: { since: Date; fields?: string[] };
  }> = [];

  for (const plan of plans) {
    const period = plan.period ? resolvePeriod(plan.period.expression, asked, calendar) : null;

    /*
     * Siloes (136) — A PAST MOMENT, RESOLVED HERE LIKE A PERIOD and for the
     * same reason. "As at last quarter" is the close of it; "since Monday" is
     * the start of it.
     */
    const asAt = plan.asAt ? resolveMoment(plan.asAt.expression, asked, calendar, 'end') : null;
    if (asAt && !isMoment(asAt)) return { outcome: 'refused', reason: asAt.reason };

    const since = plan.changed ? resolveMoment(plan.changed.since, asked, calendar, 'start') : null;
    if (since && !isMoment(since)) return { outcome: 'refused', reason: since.reason };

    if (period && !isPeriod(period)) {
      /*
       * REFUSED RATHER THAN GUESSED, which is the whole reason the resolver
       * refuses at all. "Recently" has no defensible range and inventing one
       * produces a figure somebody acts on.
       */
      return { outcome: 'refused', reason: period.reason };
    }

    /*
     * A RANGE IS TWO FILTERS, and it is built here rather than by the model. The
     * bound is half-open — inclusive at the start, exclusive at the end — so
     * consecutive periods neither overlap nor leave a gap, and a record written
     * at midnight is counted once.
     */
    bounded.push({
      plan,
      where: period
        ? [
            ...plan.where,
            { field: plan.period!.field, op: 'gte' as const, value: period.from.toISOString() },
            { field: plan.period!.field, op: 'lt' as const, value: period.until.toISOString() },
          ]
        : plan.where,
      period: period ? { expression: period.expression, from: period.from, until: period.until } : undefined,
      ...(asAt ? { asAt: asAt.at } : {}),
      ...(since ? { changed: { since: since.at, ...(plan.changed!.fields ? { fields: plan.changed!.fields } : {}) } } : {}),
    });
  }

  /* ── Stage four and five: execute each plan deterministically ─────────── */

  /*
   * A FEW AT A TIME. Every part is a read of somebody's production systems and
   * holds a pooled connection while it is planned; eight at once from one
   * question is how one person's overview starves everybody else's.
   */
  const parts: AnsweredPart[] = await inBatches(bounded, SURVEY_CONCURRENCY, async ({ plan, where, period, asAt, changed }) => {
    const answer = await askPlanned(actor, {
      conceptId: plan.conceptId,
      query: { select: plan.select, where, sort: plan.sort, limit: plan.limit, aggregate: plan.aggregate },
      ...(plan.related ? { related: plan.related } : {}),
      ...(plan.held ? { held: plan.held } : {}),
      ...(plan.analyse ? { analyse: plan.analyse } : {}),
      ...(asAt ? { asAt } : {}),
      ...(changed ? { changed } : {}),
    });

    /*
     * ── The learned layer's natural call site, which is why it was blocked ─
     *
     * `recordConnectorUse` needs to know which connections a question turned
     * out to need, and only a plan knows that. AFTER THE ANSWER, NOT BEFORE: a
     * plan that failed to execute taught nothing about which connections are
     * worth reaching for. `reinforceLink` is still blocked — a plan names one
     * concept, and a survey's parts are asked side by side, not related.
     */
    await learn(actor, plan, answer);
    return { plan, answer, ...(period ? { period } : {}) };
  });

  /* §4 — one token for a question of one system, three for one that spans several. */
  const reached = new Set(parts.flatMap((part) => part.answer.examined.map((one) => one.connectionId)));
  await tokens.spend(actor, reached.size > 1 ? 'multi_system_compile' : 'compile');

  /* The web's part in an answer from the systems is the write-up's: it looks up what the answer found. */
  return parts.length === 1 ? { outcome: 'answered', ...parts[0]! } : { outcome: 'surveyed', parts };
}

/* How many parts of a survey read their systems at once. */
const SURVEY_CONCURRENCY = 3;

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return results;
}

/**
 * The shape of a question, with none of its words.
 *
 * THE CONCEPT, THE FIELDS AND THE OPERATORS — sorted, so two askings of the
 * same question in different English produce the same fingerprint. The values
 * are deliberately absent: 036 stores a hash precisely so a customer's own
 * words, which routinely carry a supplier name or an amount, never reach the
 * learned layer.
 */
function shapeOf(plan: Extract<Compiled, { outcome: 'plan' }>['plan']): string {
  return [
    plan.conceptId,
    [...plan.select].sort().join(','),
    [...plan.where].map((one) => `${one.field}:${one.op}`).sort().join(','),
    [...plan.aggregate].map((one) => `${one.operation}:${one.field}`).sort().join(','),
  ].join('|');
}

/**
 * What the model is asked to produce.
 *
 * STATED AS A SHAPE RATHER THAN AN EXAMPLE. An example invites pattern matching
 * against its values, and the one thing that must never reach this prompt is a
 * value.
 */
function planShape(): string {
  return [
    'Return exactly one of these JSON objects and nothing else.',
    '',
    'A plan:',
    '{"conceptId": "<id from the list>", ' +
      '"period": {"expression": "<the asker\'s own words>", "field": "<time field>"}, ' +
      '"select": ["<field>"], ' +
      '"where": [{"field": "<field>", "op": "<operator>", "value": <json>}], ' +
      '"sort": [{"field": "<field>", "direction": "asc|desc"}], "limit": <integer>, ' +
      '"aggregate": [{"operation": "count|sum|average|minimum|maximum", "field": "<field>"}], ' +
      '"judge": "<a criterion no field holds, in the asker\'s words>", ' +
      '"related": [<a related condition>], "held": [{"system": "<a system it is held in>", "present": true|false}], ' +
      '"analyse": [<a table>], ' +
      '"asAt": {"expression": "<the asker\'s own words for a past moment>"}, ' +
      '"changed": {"since": "<the asker\'s own words>", "fields": ["<field>"]}}',
    '',
    'RECORDS PICKED BY OTHER RECORDS. "Customers with an overdue invoice", "deals for companies with an open',
    'ticket", "customers never invoiced": plan the concept the question wants LISTED, and add a related condition for',
    'each other kind of record it is picked by. Only a concept named in that concept\'s "related to" can be used:',
    '  {"conceptId": "<related concept id>", "where": [<filters on ITS fields>], "exists": true|false,',
    '   "as": "<lower_case_name>", "total": {"operation": "count|sum", "field": "<one of ITS fields>"},',
    '   "related": [<one related condition on IT, when the question goes one step further>]}',
    '"exists": false keeps the records that have NONE. Several conditions must all hold, and may be in different systems.',
    '"as" with "total" puts a figure on every record kept — how many related records it has, or the sum of one of their',
    'fields — and that name can then be used in "sort", "aggregate" and "analyse" like a field: "the five customers who',
    'owe most" is customers, related invoices as "owed" summing the amount due, sorted by owed descending, limit 5; "how',
    'much is overdue for customers with an open deal" is customers with both conditions and an aggregate summing that figure.',
    '',
    'RECORDS PICKED BY WHICH SYSTEM HOLDS THEM. "In the ledger but not in the CRM": "held" with the system names from',
    '"held in", present true or false.',
    '',
    'FIGURES BY GROUP OR OVER TIME. Whenever the question asks for a breakdown, a comparison between groups, a trend,',
    '"by month", "per stage", "which has the most" — add a table to "analyse". It is computed exactly over EVERY matched',
    'record, not the rows listed, so prefer it to reading rows:',
    '  {"kind": "breakdown", "by": "<field>", "measure": {"operation": "count|sum|average|minimum|maximum", "field": "<number field>"}, "top": <integer>, "order": "asc|desc"}',
    '  {"kind": "trend", "time": "<date field>", "every": "day|month|quarter|year", "measure": {…}}',
    '  {"kind": "crosstab", "by": ["<field>", "<field>"], "measure": {…}}',
    'A count needs no "field". Filters and periods still apply: "paid revenue by month this year" is a filter, a period and a trend.',
    '',
    'HOW THINGS STOOD, AND WHAT HAS CHANGED. A period picks records by a date they carry ("invoices raised last',
    'quarter"). These two are different: they are about the records themselves at another time.',
    '"asAt" — how the records stood at a past moment: "what was the pipeline worth at the end of last quarter", "how',
    'many open deals did we have on 2026-07-01". Give the words for the span or day, as a period\'s expression is given;',
    'the moment is the close of it. Everything else in the plan is then asked of the records as they were.',
    '"changed" — only the records that differ from how they stood: "what changed in deals since yesterday", "which',
    'customers moved tier this month" (fields: the tier field). "since" is the words for when; "fields" narrows it to',
    'records in which one of those changed, and without it a new record or a change to any field counts. The rest of',
    'the plan applies to those records: "what are the deals that changed stage this week worth" sums over them.',
    'Use them whenever the question is about a past state or about change, even if unsure anything was kept from then:',
    'Silo answers from what it has, and says so plainly where it has nothing.',
    '',
    'WHEN THE QUESTION PICKS RECORDS BY SOMETHING NO FIELD HOLDS — an industry, what a company sells or',
    'who it sells to, whether it is a competitor, a region with no location field — DO NOT REFUSE. Plan the',
    'read of every concept it could apply to, without a filter for it, and put the criterion in the asker\'s',
    'own words in "judge" (e.g. "sells into defence"). Silo judges it afterwards, record by record, from the',
    'records\' own fields and then public sources. Apply any criteria a field does hold as ordinary filters.',
    'A criterion about what an organisation does applies to the organisations: "a contact at a company that sells',
    'into defence" or "a customer that is a defence company" reads the companies (and the people, if asked for)',
    'with "plans". When unsure which concepts are meant, plan every one that could be, never just one.',
    '',
    `Several plans, when the question is about more than one concept — everything a system holds`,
    `("what is in HubSpot", "what do we have in Xero"), an overview, or two kinds of record at once.`,
    `One plan per concept, at most ${MOST_PLANS}. Omit select in a plan to read every field:`,
    '{"plans": [<a plan>, <a plan>]}',
    '',
    'A question naming a system means the concepts held in that system; "held in" lists them.',
    '',
    'A refusal, only when no concept listed could hold the records the question is about at all:',
    '{"refusal": "<why, in one sentence>"}',
    '',
    'A clarification, only when the question clearly wants ONE concept and two or more could be meant.',
    'If it could reasonably want all of them, plan all of them instead of asking:',
    '{"ambiguous": {"question": "<what to ask>", "options": ["<conceptId>", "<conceptId>"]}}',
    '',
    'Outside the systems, when the question is not about the organisation\'s own records at all —',
    'a definition, a benchmark, a public fact, general advice:',
    '{"outside": true}',
    '',
    'A reply, when the message is conversation rather than a question — a greeting, thanks, "what can you do",',
    '"what have I connected". One to three friendly sentences in British English. You may name the systems and',
    'concepts listed and suggest two or three specific questions worth asking of them. Never state a figure or a',
    'value; you have not seen any:',
    '{"reply": "<what to say>"}',
    '',
    'A change request, when the words ask for records to be changed rather than read —',
    'set, update, mark, assign, close, reopen, correct or delete them — even when phrased',
    'as a question such as "can you mark these as paid?". Return only this; do not plan it:',
    '{"change": true}',
    '',
    'Every clause is optional except conceptId. Omit what the question did not ask for,',
    'and omit a clause entirely rather than sending an empty or malformed one.',
    'Use only concept ids, field names and operators from the list below.',
    'A field is only filterable with the operators that concept lists.',
    'Never invent a concept, a field or an operator. Refuse instead.',
  ].join('\n');
}

/** Record what was asked and what came of it, before anything is executed. */
async function record(
  actor: Actor,
  question: string,
  compiled: Compiled,
  result: { inputTokens: number; outputTokens: number; durationMs: number },
): Promise<void> {
  await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction((db) =>
        writeAudit(db, {
          event: 'question_compiled',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          /*
           * THE OUTCOME AND THE COST, NEVER THE QUESTION. A customer's own
           * words routinely contain a supplier name, a person or an amount,
           * and §6.1 is explicit that no values reach the learned or audited
           * layers. The length says something was asked; the text does not.
           */
          detail: {
            outcome: compiled.outcome,
            questionLength: question.length,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        }),
      ),
  );
}

/**
 * What this question taught the map.
 *
 * FAILURE IS NOT RECORDED AS PREFERENCE. A plan that could not be executed says
 * nothing about which connections are worth reaching for, and recording it
 * would teach the map to favour whatever happened to be broken.
 */
async function learn(
  actor: Actor,
  plan: Extract<Compiled, { outcome: 'plan' }>['plan'],
  answer: ConceptAnswer,
): Promise<void> {
  const connectionIds = [...new Set(answer.examined.map((one) => one.connectionId))];
  if (connectionIds.length === 0) return;

  try {
    await runWithTenant(
      { organisationId: actor.organisationId, membershipId: actor.membershipId },
      () =>
        withTransaction((db) => recordConnectorUse(db, actor, { shape: shapeOf(plan), connectionIds })),
    );
  } catch (error) {
    /*
     * LEARNING IS NOT THE ANSWER. A map that cannot be written is a degraded
     * ranking next time, not a failed question — and throwing here would lose
     * an answer the customer's systems have already been asked for.
     */
    log.info({ err: error }, 'Could not record what this question taught the map');
  }
}

/**
 * §7.3 — what day it is, and whose year it is.
 *
 * ── THE MODEL IS TOLD THE DATE AND NOT ASKED TO USE IT ─────────────────────
 *
 * A model has no clock. Asked for "last quarter" with no date in the prompt it
 * emits two literal dates from its training-era notion of now — confidently,
 * silently, and wrong by however long ago that was. Told the date, it would
 * still be doing calendar arithmetic against a financial year it cannot check,
 * on a question that may be saved and re-run next month.
 *
 * So it is told the date for one purpose only: to know whether a phrase refers
 * to a period at all, and to repeat that phrase back. `resolvePeriod` does the
 * arithmetic, deterministically, at the moment the question runs.
 *
 * NO VALUES ARE ADDED BY THIS. A date and a fiscal calendar are properties of
 * the organisation, not of its data.
 */
function describeCalendar(calendar: Calendar, now: Date): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: calendar.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, calendar.yearStartsInMonth - 1, 1)),
  );

  return [
    `Today is ${today} in ${calendar.timeZone}. The financial year starts in ${month}.`,
    'For a question about a period, DO NOT write dates into `where`.',
    'Put the asker\'s own words in `period.expression` and name the date field in `period.field`:',
    '  {"period": {"expression": "last quarter", "field": "<a time field from the concept>"}}',
    'Understood expressions: today, yesterday, this/last month, this/last quarter,',
    'this/last year, year to date, "the past N days|weeks|months|years",',
    '"since YYYY-MM-DD", "between YYYY-MM-DD and YYYY-MM-DD".',
    'Omit `period.field` to use the concept\'s default time field.',
    'If the question names no period, omit `period` entirely.',
  ].join('\n');
}
