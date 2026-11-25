import { z } from 'zod';
import { MOST_PLANS } from '../engine/ontology/compile.ontology';
import { READING_ROWS } from '../engine/render/reading.render';

/**
 * §7 — a question in plain English.
 *
 * BOUNDED AT THE DOOR. The question reaches a model, and a model is charged by
 * the token; a body of unlimited length is a bill of unlimited size. The
 * history is bounded for the same reason and because a long conversation
 * crowds the vocabulary out of the prompt, which is the part that must not be
 * crowded out.
 */
export const askQuestion = z
  .object({
    question: z.string().min(1).max(2000).trim(),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'model']),
            text: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    /**
     * Whether the Console may look outside the organisation's systems — the
     * web, and what is generally known — for this question. The asker's
     * choice, made in the box, per question; off unless they say.
     */
    outside: z.boolean().optional(),
  })
  .strict();

const turn = (most: number) =>
  z
    .object({
      role: z.enum(['user', 'model']),
      text: z.string().min(1).max(most),
    })
    .strict();

const count = z.number().int().min(0);

const fieldProfile = z
  .object({
    fieldPath: z.string().min(1).max(200),
    kind: z.enum(['number', 'date', 'text', 'boolean', 'empty']),
    present: count,
    missing: count,
    disputed: count,
    number: z.object({ sum: z.number(), minimum: z.number(), maximum: z.number(), average: z.number() }).strict().optional(),
    date: z
      .object({
        earliest: z.string().max(40),
        latest: z.string().max(40),
        by: z.enum(['month', 'year']),
        counts: z.array(z.object({ period: z.string().max(10), count }).strict()).max(400),
      })
      .strict()
      .optional(),
    values: z
      .object({
        distinct: count,
        top: z.array(z.object({ value: z.string().max(100), count }).strict()).max(12),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * 129 — an answer sent back to be written up.
 *
 * WHAT THE CONSOLE WAS HANDED, AND NO MORE. The rows and the profile are the
 * answer this person was just given, bounded here as the disclosure states —
 * `READING_ROWS` records a part at most — and so that a body of unlimited size
 * is not a bill of unlimited size.
 */
export const readAnswer = z
  .object({
    question: z.string().min(1).max(2000).trim(),
    history: z.array(turn(2000)).max(20).optional(),
    parts: z
      .array(
        z
          .object({
            concept: z.string().min(1).max(200),
            /** Which concept this is an answer about, so what the write-up learns about its fields can be kept. */
            conceptId: z.string().uuid().optional(),
            systems: z.array(z.string().max(200)).max(20),
            matched: count,
            profile: z.array(fieldProfile).max(1_000),
            /** Fields the system holds that are empty on every matched record: names only. */
            empty: z.array(z.string().min(1).max(128)).max(1_000).optional(),
            /** Whether these are every field the system holds. */
            fieldsListed: z.boolean().optional(),
            /** Fields the records were picked by, and the systems that hold no such field: names only. */
            unheld: z
              .array(
                z
                  .object({
                    field: z.string().min(1).max(128),
                    systems: z.array(z.string().max(200)).min(1).max(20),
                    /** How many records that left unchecked, where Silo could count them. */
                    unchecked: z.number().int().min(0).max(10_000_000).optional(),
                  })
                  .strict(),
              )
              .max(20)
              .optional(),
            /** When the kept copy these were read from was made. */
            asOf: z.string().datetime().optional(),
            /** The past moment the question asked about. */
            asAt: z.string().datetime().optional(),
            /** When the copy was caught up with what changed since, and how many records that was. */
            fresh: z.object({ at: z.string().datetime(), records: count }).strict().optional(),
            /** What differs between two copies, per system: counts, field names and the names of records gone. */
            changes: z
              .object({
                fields: z.array(z.string().min(1).max(128)).max(20).optional(),
                systems: z
                  .array(
                    z
                      .object({
                        system: z.string().max(200),
                        from: z.string().datetime(),
                        to: z.string().datetime(),
                        added: count,
                        removed: count,
                        changed: count,
                        fields: z.array(z.object({ field: z.string().min(1).max(128), records: count }).strict()).max(20),
                      })
                      .strict(),
                  )
                  .max(20),
                gone: z.array(z.string().max(300)).max(50),
              })
              .strict()
              .optional(),
            /** The other kinds of record these were picked by. */
            joins: z
              .array(
                z
                  .object({
                    concept: z.string().max(200),
                    exists: z.boolean(),
                    matched: count,
                    reached: count,
                    route: z.string().max(500).nullable(),
                    as: z.string().max(64).optional(),
                  })
                  .strict(),
              )
              .max(8)
              .optional(),
            /** Exact figures Silo worked out over every matched record. */
            tables: z
              .array(
                z
                  .object({
                    kind: z.enum(['breakdown', 'trend', 'crosstab']),
                    by: z.array(z.string().max(128)).min(1).max(2),
                    measure: z.object({ operation: z.string().max(20), field: z.string().max(128).optional() }).strict(),
                    every: z.string().max(20).optional(),
                    rows: z.array(z.object({ key: z.array(z.string().max(300)).max(2), value: z.number().nullable(), records: count }).strict()).max(500),
                    left: z.object({ disputed: count, unmeasured: count }).strict().optional(),
                    beyond: z.object({ groups: count, records: count }).strict().optional(),
                  })
                  .strict(),
              )
              .max(4)
              .optional(),
            /** Pairs of values the systems keep giving for one field: what was read as one, and what still disagrees. */
            written: z
              .array(
                z
                  .object({
                    field: z.string().min(1).max(128),
                    a: z.object({ system: z.string().max(200), value: z.string().max(300) }).strict(),
                    b: z.object({ system: z.string().max(200), value: z.string().max(300) }).strict(),
                    records: z.number().int().min(1).max(10_000_000),
                    alike: z.boolean(),
                  })
                  .strict(),
              )
              .max(40)
              .optional(),
            aggregates: z
              .array(z.object({ operation: z.string().max(20), fieldPath: z.string().max(200), value: z.number().nullable() }).strict())
              .max(10),
            rows: z
              .array(
                z
                  .object({
                    name: z.string().max(500),
                    values: z.record(z.string().max(200), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
                    /** What each changed field held in the earlier copy, where the question asked what changed. */
                    was: z.record(z.string().max(200), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
                    added: z.boolean().optional(),
                  })
                  .strict(),
              )
              .max(READING_ROWS),
            /** What the question picked records by that no field holds, to be judged from outside. */
            judge: z.string().min(1).max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MOST_PLANS),
    outside: z
      .object({
        paragraphs: z.array(z.string().max(4000)).max(12),
        sources: z.array(z.object({ n: count, title: z.string().max(300), url: z.string().max(2000) }).strict()).max(40),
      })
      .strict()
      .optional(),
    /** A conversation about this answer: the write-up so far, and what has been asked of it. Ends with a question. */
    discussion: z.array(turn(6000)).max(20).optional(),
    /** The asker has the web switched on: a follow-up may look outside the systems again. */
    web: z.boolean().optional(),
  })
  .strict();

/** 129 — a super admin switching answers written up by a model off for the organisation, or back on. */
export const setAnswerReading = z.object({ enabled: z.boolean() }).strict();
