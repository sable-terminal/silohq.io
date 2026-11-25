import type { ContributingObject } from '../../models/concept.model';
import type { Comparison } from '../execution/query.execution';

/**
 * §7.1 — what a question is allowed to be about.
 *
 * ── The ordering that is the whole guarantee ───────────────────────────────
 *
 * This is built BEFORE any model runs, from what the reader can actually see:
 * the connections they hold grants on, the concepts they are cleared for, and
 * the fields those concepts map. Everything outside it does not exist as far as
 * the next stage is concerned.
 *
 * A DENIED FIELD NEVER ENTERS A PLAN BECAUSE THE MODEL WAS NEVER TOLD IT
 * EXISTED. That is a different guarantee from filtering a plan afterwards, and
 * a much stronger one: post-filtering leaves the model free to compose a
 * question around a field it should not know about, and the refusal that
 * follows tells the reader the field is there. Nothing here can leak by
 * omission, because omission is the mechanism.
 *
 * ── Names, never values ────────────────────────────────────────────────────
 *
 * Concept names, field names, and what each source declares it can do. No
 * samples, no rows, no figures. `model.infra` states the same rule at the other
 * end of the wire; this is the half that decides what is put on it.
 */

export type ConceptVocabulary = {
  conceptId: string;
  name: string;
  /**
   * The concept's own field names, across every contributing object.
   *
   * A UNION. A field only one system holds is answerable — the others hold no
   * reading, which `merge` treats as absence — and filterable: the systems
   * that hold it apply the filter, and the answer names the ones that do not.
   */
  fields: string[];
  /**
   * Filter operators EVERY contributing connection can push down.
   *
   * AN INTERSECTION, WHICH IS STRICTER THAN IT NOW HAS TO BE. A filter reaches
   * only the systems that hold its field, so strictly an operator need be
   * supported only there — but which systems those are depends on the field,
   * and one list per concept is what the model is shown. Offering only what
   * every system can do is never wrong, merely cautious.
   */
  filters: Comparison[];
  /** Aggregates every contributing connection can push down. Same reasoning. */
  aggregates: Array<'count' | 'sum' | 'group_by'>;
  /**
   * §7.3 — the fields a question about time could mean.
   *
   * MOST CONCEPTS HAVE SEVERAL and the difference is usually material: an
   * invoice raised in March, amended in April and dated to February appears in
   * three different quarters depending which one the question meant.
   */
  timeFields: Array<{ fieldPath: string; kind: string; isDefault: boolean }>;
  /**
   * The systems holding it, by the names people gave their connections.
   *
   * "WHAT IS IN MY HUBSPOT" NAMES A SYSTEM, NOT A CONCEPT. Without this the
   * model was offered Contact, Company and Deal with nothing saying where any of
   * them lived, so a question about a system could only be answered by asking
   * which concept was meant. A connection's name is the customer's own label
   * for it — not a value from inside it.
   */
  systems: string[];
  /**
   * §4.1 — the other concepts a declared key relates this one to.
   *
   * ONLY JOINS THAT CAN RUN. A plan may pick this concept's records by another
   * kind of record ("customers with an overdue invoice") only where one of the
   * customer's own systems declares the key between them; the model is told
   * which those are, so it does not plan a join that would be refused.
   */
  links: Array<{ conceptId: string; name: string }>;
};

export type Capability = {
  filters: readonly Comparison[];
  aggregates: ReadonlyArray<'count' | 'sum' | 'group_by'>;
};

/**
 * The vocabulary for a set of concepts the reader may already see.
 *
 * IT DOES NOT DECIDE WHO MAY SEE WHAT. The caller passes in the concepts that
 * survived clearance and reachability; this turns them into the words a plan is
 * allowed to use. Putting the permission check here would make a pure function
 * responsible for an authorisation decision, which is the line `repos/README`
 * draws for repos and the same argument applies.
 */
export function vocabularyOf(input: {
  concepts: ReadonlyArray<{
    id: string;
    name: string;
    objects: readonly ContributingObject[];
    /** §2.3 (131) — names every system also reads under another, so not offered twice. */
    superseded?: readonly string[];
  }>;
  /** Per connection, what that source declares it can push down. */
  capabilities: ReadonlyMap<string, Capability>;
  /** Per concept, the fields a period could apply to. */
  timeFields?: ReadonlyMap<string, Array<{ fieldPath: string; kind: string; isDefault: boolean }>>;
  /** Per connection, the name people know it by. */
  systemNames?: ReadonlyMap<string, string>;
  /** Pairs of concepts a declared key relates, either way round. */
  relationships?: ReadonlyArray<{ fromConceptId: string; toConceptId: string }>;
}): ConceptVocabulary[] {
  const offered = new Map(input.concepts.map((concept) => [concept.id, concept.name]));
  const linkedTo = (conceptId: string) =>
    [
      ...new Set(
        (input.relationships ?? []).flatMap((one) =>
          one.fromConceptId === conceptId ? [one.toConceptId] : one.toConceptId === conceptId ? [one.fromConceptId] : [],
        ),
      ),
    ]
      /* Only to a concept this reader is also offered: a link to one they cannot see would name it. */
      .filter((id) => id !== conceptId && offered.has(id))
      .map((id) => ({ conceptId: id, name: offered.get(id)! }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return input.concepts
    .map((concept) => {
      /*
       * ONE NAME PER THING. Where an answer taught that two systems' fields are
       * one, the model is offered the shared name and not the old ones as well
       * — or it would be choosing between `town` and `city` for a question
       * about where somebody is, and half the time ask one system.
       */
      const superseded = new Set(concept.superseded ?? []);

      const fields = new Set<string>();
      for (const object of concept.objects) {
        for (const field of Object.keys(object.fieldMap)) if (!superseded.has(field)) fields.add(field);
      }

      const declared = concept.objects.map(
        (object) =>
          input.capabilities.get(object.connectionId) ?? { filters: [], aggregates: [] },
      );

      /*
       * AN EMPTY CONCEPT HAS NO VOCABULARY, and a concept with no objects the
       * reader can reach arrives here with none. Intersecting over an empty
       * list would produce everything, which is the wrong direction entirely.
       */
      const intersect = <T>(lists: ReadonlyArray<readonly T[]>): T[] => {
        if (lists.length === 0) return [];
        return [...lists[0]!].filter((one) => lists.every((list) => list.includes(one)));
      };

      /*
       * ── A TIME FIELD SOME SYSTEM MAPS, BECAUSE A PERIOD IS A FILTER ───────
       *
       * A period is answered the way any filter is: by the systems that hold
       * the field, with the answer naming the ones that do not. So a date only
       * one system records is offered — "invoices closed this quarter" has an
       * answer when only the ERP records a closing date — and it may be the
       * default.
       *
       * This was every system, while `planConceptQuery` refused a filter not
       * all of them could apply; advertising one then spent a model call on a
       * plan that was refused. It refuses no longer, and keeping the stricter
       * rule here would go on refusing by omission what the planner answers.
       *
       * A FIELD NO SYSTEM MAPS IS STILL NOT OFFERED: hidden from this reader
       * everywhere it lives, or declared before a correction renamed it.
       */
      const mappedSomewhere = (fieldPath: string) =>
        concept.objects.some((object) => fieldPath in object.fieldMap);

      const times = (input.timeFields?.get(concept.id) ?? []).filter((one) =>
        mappedSomewhere(one.fieldPath),
      );

      return {
        conceptId: concept.id,
        name: concept.name,
        fields: [...fields].sort(),
        filters: intersect(declared.map((one) => one.filters)).sort(),
        aggregates: intersect(declared.map((one) => one.aggregates)).sort(),
        timeFields: times,
        systems: [
          ...new Set(
            concept.objects
              .map((object) => input.systemNames?.get(object.connectionId))
              .filter((name): name is string => Boolean(name)),
          ),
        ].sort(),
        links: linkedTo(concept.id),
      };
    })
    /*
     * A CONCEPT WITH NO FIELDS IS NOT OFFERED. It cannot answer anything, and
     * naming it in the vocabulary invites a plan that is then refused — which
     * spends a model call to produce a refusal the vocabulary already knew.
     */
    .filter((concept) => concept.fields.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The vocabulary as the model is shown it.
 *
 * ── Deliberately flat and deliberately dull ────────────────────────────────
 *
 * It is a list of names and what may be done with them. There is no prose to
 * reason from, no examples to pattern-match against, and above all no values —
 * a single sample row would put a customer's data in somebody else's inference
 * pipeline, whatever the contract says.
 *
 * THE IDS ARE IN IT BECAUSE THE PLAN MUST NAME ONE. A plan naming a concept by
 * name would need resolving against the same list afterwards, and two concepts
 * can share a name across a rename.
 */
export function describeVocabulary(vocabulary: readonly ConceptVocabulary[]): string {
  if (vocabulary.length === 0) return '(no concepts are available to this reader)';

  return vocabulary
    .map((concept) =>
      [
        `concept ${concept.conceptId} "${concept.name}"`,
        `  held in: ${concept.systems.join(', ') || '(unnamed)'}`,
        `  fields: ${concept.fields.join(', ')}`,
        `  filters: ${concept.filters.join(', ') || '(none can be pushed down)'}`,
        `  aggregates: ${concept.aggregates.join(', ') || '(none can be pushed down)'}`,
        /* Named with their ids, because a related condition has to name one. */
        `  related to: ${concept.links.map((link) => `"${link.name}" ${link.conceptId}`).join(', ') || '(nothing declares a key to another concept)'}`,
        /*
         * THE DEFAULT IS NAMED SO THE MODEL NEED NOT ASK, and the others are
         * named so it CAN. A concept with several time fields and no default is
         * a question this cannot answer without asking which was meant — the
         * same treatment as two concepts that could both be meant.
         */
        `  time: ${describeTimes(concept.timeFields)}`,
      ].join('\n'),
    )
    .join('\n\n');
}

const describeTimes = (
  times: ReadonlyArray<{ fieldPath: string; kind: string; isDefault: boolean }>,
): string => {
  if (times.length === 0) return '(no field is declared a time, so no period can be applied)';

  return times
    .map((one) => `${one.fieldPath} (${one.kind}${one.isDefault ? ', default' : ''})`)
    .join(', ');
};
