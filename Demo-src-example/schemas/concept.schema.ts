import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/*
 * A FIELD PATH, NOT A VALUE, EVERYWHERE IN HERE. §2.5 and §3.2 both turn on the
 * same rule: an entity is referred to by identifier and never by its contents.
 * Nothing in this schema accepts a value read out of a customer's data, and
 * nothing should be added that does.
 */
const fieldPath = z.string().min(1).max(256);

const contributing = z
  .object({
    connectionId: z.string().uuid(),
    objectName: z.string().min(1).max(128),
    identifierField: fieldPath,
    /*
     * ORDERED, AND AT LEAST ONE. Resolution walks them in order and the first
     * that matches decides; an empty list is a concept that can never resolve,
     * which is worth refusing at the door rather than discovering at query time.
     */
    matchKeys: z.array(fieldPath).min(1).max(8),
    /*
     * §2.3 — OPTIONAL, AND DERIVED WHEN ABSENT. The concept's name for each
     * field and this system's name for it. A caller may state it; if they do
     * not, the service computes it from the manifest with the same rule the
     * comparison uses.
     *
     * IT HAS TO BE ACCEPTED HERE, and that is what was missing: this object is
     * `.strict()`, so a body carrying a field map was REJECTED, and a body
     * without one stored an empty map — which made every question about a named
     * field refuse as unknown. The layer was reachable from tests calling the
     * service directly and from nothing else.
     */
    fieldMap: z.record(fieldPath, fieldPath).optional(),
  })
  .strict();

export const confirmConcept = z
  .object({
    name: z.string().min(1).max(128),
    /*
     * TWO, MINIMUM. §2.7 — a single system has nothing to resolve against, so a
     * one-object concept cannot do anything. The service says so too, because
     * this schema is the door and that one is the rule.
     */
    objects: z.array(contributing).min(2).max(16),
    proposalId: z.string().uuid().optional(),

    /*
     * §2.5 — SET AT CONFIRMATION, because that is the only moment somebody is
     * looking at what the concept spans. Applying them afterwards leaves a
     * window in which it resolves unrestricted, and that window is exactly when
     * the first queries get run against something new.
     */
    markingIds: z.array(z.string().uuid()).max(16).optional(),
  })
  .strict();

/*
 * ── Correction ─────────────────────────────────────────────────────────────
 *
 * A RENAME NEEDS NO REASON AND A RE-KEY DOES. Renaming resolves exactly the
 * same rows, so nothing past changes meaning. Changing which objects contribute
 * changes WHICH ROWS ARE THE SAME ENTITY — every earlier finding was computed
 * against a different definition — and the database refuses that without a
 * reason for the same purpose this schema does.
 */
export const renameConcept = z
  .object({
    name: z.string().min(1).max(128),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const correctConcept = z
  .object({
    objects: z.array(contributing).min(2).max(16),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export const retireConcept = z
  .object({ reason: z.string().min(1).max(2000) })
  .strict();

/*
 * SET, NOT ADD. Removal is the operation that matters — it widens who can see
 * something, silently, for everybody — and an add-only shape makes it invisible.
 * An empty array is a legitimate request meaning "restrict this no further".
 */
export const setConceptMarkings = z
  .object({
    markingIds: z.array(z.string().uuid()).max(16),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();

/**
 * Running derivation.
 *
 * `sampleValues` IS THE ONLY KNOB AND IT DEFAULTS ON, because §2.2 names value
 * matching as one of four inputs and a derivation that skips it is a weaker
 * claim wearing the same name. It can be turned off: a first run against a
 * production ERP somebody is nervous about is a reasonable time to look at
 * schemas only, and the evidence records which it was.
 */
export const runDerivation = z
  .object({ sampleValues: z.boolean().optional() })
  .strict();

/**
 * §4.1 — walking from instances of one concept to instances of another.
 *
 * `entityRefs` ARE IDENTIFIERS AND NOTHING ELSE, which is the same line the
 * rest of this file draws: a walk starts from the things a system calls itself
 * by, never from what any of them contained.
 *
 * THE START IS BOUNDED AT THE DOOR. A walk fans out multiplicatively and
 * `bounds.util` refuses a frontier past its ceiling — but a request naming ten
 * thousand starting instances should not need to reach the engine to be told
 * no, and a body that large is a mistake rather than a question.
 */
export const walkConcepts = z
  .object({
    fromConceptId: z.string().uuid(),
    toConceptId: z.string().uuid(),
    entityRefs: z.array(z.string().min(1).max(512)).min(1).max(500),
    /*
     * WHICH ROUTE, because there is usually more than one and they are
     * different claims. Omitted means the shortest; the response lists them all
     * with the system that declared each, so a second call can name another.
     */
    routeIndex: z.number().int().min(0).max(63).optional(),
  })
  .strict();

/**
 * §2.6 — resolving a concept across the systems it spans.
 *
 * NOTHING BUT A CEILING. The caller names a concept; the rows are this server's
 * to fetch. An earlier shape took the rows as an argument, which could never
 * have been routed — it would have meant a client posting customer records into
 * a product whose claim is that it does not store them.
 */
export const resolveConcept = z
  .object({
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

/**
 * §7 — asking a question in a concept's own words.
 *
 * ── The join is accepted and refused, deliberately ─────────────────────────
 *
 * "Invoices, and the supplier each one names" is two concepts and a
 * relationship, and it is not built. The shape accepts it anyway, because
 * shipping `{ from, where, select }` and adding `join` later would mean
 * changing an API callers had already built on — and the thing that gets
 * changed in that situation is usually the caller.
 *
 * So the field exists, the planner refuses it by name, and a client can tell
 * "not yet" from "you asked wrongly". A silent success that ignored the join
 * would be the one outcome worth avoiding: an answer about invoices alone,
 * presented as an answer about invoices and their suppliers.
 */
const conceptFilter = z
  .object({
    field: z.string().min(1).max(256),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null']),
    value: z.unknown().optional(),
  })
  .strict();

export const askConcept = z
  .object({
    select: z.array(z.string().min(1).max(256)).max(100).default([]),
    where: z.array(conceptFilter).max(50).default([]),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1).max(256),
            direction: z.enum(['asc', 'desc']).default('asc'),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    /** Entities in the answer, not rows in the fetch. */
    limit: z.number().int().min(1).max(1000).default(100),
    /*
     * §7 — totals over ENTITIES rather than rows, which is the only place they
     * are correct: a sum across two systems double-counts everything both hold.
     * Each figure comes back with what it could not include.
     */
    aggregate: z
      .array(
        z
          .object({
            operation: z.enum(['count', 'sum', 'average', 'minimum', 'maximum']),
            field: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    /**
     * §4.1 — the other concept this question is also about.
     *
     * IT CARRIES ITS OWN FILTERS. "Invoices over ten thousand, with their ACTIVE
     * suppliers" is two conditions on two concepts, and a join that could only
     * SELECT from the far side would answer half of it.
     *
     * ONE, NOT FOUR. Two joins is a shape whose answer nobody can check — three
     * concepts paired by identifier, where a record reaching two on one side and
     * three on the other is a fact the response would have to express and a
     * reader would have to hold. Refused by length rather than answered
     * partially, which is what the whole clause was reserved to allow.
     */
    join: z
      .array(
        z
          .object({
            to: uuid,
            select: z.array(z.string().min(1).max(256)).max(100).default([]),
            where: z.array(conceptFilter).max(50).default([]),
            limit: z.number().int().min(1).max(1000).default(100),
            /** Routes are different CLAIMS, so which one was taken is the
                caller's to choose and the answer states what was available. */
            routeIndex: z.number().int().min(0).max(10).optional(),
          })
          .strict(),
      )
      .max(1)
      .optional(),
  })
  .strict();
