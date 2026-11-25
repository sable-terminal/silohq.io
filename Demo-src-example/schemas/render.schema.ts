import { z } from 'zod';
import { PRECEDENCE } from '../engine/render/select.render';

/*
 * §3 at the door.
 *
 * THE TEN ARE A CLOSED SET, and this takes them from the precedence rather than
 * restating them. They were written out here by hand, which meant the closed
 * set existed in three places — the model's union, the engine's precedence and
 * this list — and the day an eleventh is added deliberately "to the whole
 * product", two of the three would be right.
 *
 * `table` is among them because §4.4 makes it the floor: a result that matches
 * nothing renders as rows rather than failing, which is what makes broad
 * coverage safe to claim.
 */
const archetype = z.enum(PRECEDENCE as unknown as [string, ...string[]]);

/**
 * §4.1's signals, as a caller describes the result it is holding.
 *
 * ── STRUCTURE, AND NOTHING THAT COULD CARRY A VALUE ───────────────────────
 *
 * Counts, booleans, edges between row references and measure names. §1 —
 * "Selection reads structure, never subject" — and the schema is where that
 * stops being a convention: there is nowhere in this shape to put a figure, so
 * a client cannot send one and the precedence cannot read one.
 *
 * ── THE CALLER NO LONGER SENDS AN ARCHETYPE ───────────────────────────────
 *
 * It used to send `chosen` and `alternatives`, having picked them itself. §4.3
 * makes the override rate "the only measure of whether precedence is right",
 * and a rate built from the client's own choice measures the client. The server
 * selects from this shape and records what IT chose.
 */
const measure = z
  .object({
    fieldPath: z.string().min(1).max(256),
    contested: z.boolean().default(false),
    numeric: z.boolean().default(false),
  })
  .strict();

export const resultShape = z
  .object({
    rowCount: z.number().int().min(0).max(1_000_000),
    measures: z.array(measure).max(256).default([]),
    timeField: z.string().min(1).max(256).nullable().default(null),
    orderedByTime: z.boolean().default(false),
    /*
     * THE THREE THE SERVER ADDED AND THIS DID NOT. `shapeOf` began sending
     * which fields an archetype is drawn over, and the client sends the shape
     * straight back to record the selection — so a strict schema without them
     * refused every recording, and §11's trail stayed empty without a sound.
     * `render.service.test` now round-trips a real shape through this.
     */
    orderedByMeasure: z.boolean().default(false),
    orderedField: z.string().min(1).max(256).nullable().optional(),
    summedField: z.string().min(1).max(256).nullable().optional(),
    edges: z
      .array(z.object({ from: z.string().min(1).max(512), to: z.string().min(1).max(512) }).strict())
      .max(10_000)
      .default([]),
    directedEdges: z.boolean().default(false),
    summable: z.boolean().default(false),
    deviationComputed: z.boolean().default(false),
  })
  .strict();

export const recordSelection = z
  .object({
    resultRef: z.string().min(1).max(128),
    shape: resultShape,
  })
  .strict();

export const overrideSelection = z
  .object({ resultRef: z.string().min(1).max(128), to: archetype })
  .strict();

/*
 * §2's three, and there is no fourth. Prose is the default for everything, so
 * choosing it is still a choice — "never chose" and "chose prose" are different
 * facts and only one of them says somebody looked.
 */
export const representation = z.enum(['prose', 'view', 'data']);

export const preferRepresentation = z
  .object({ viewId: z.string().uuid(), representation })
  .strict();

export const viewId = z.object({ id: z.string().uuid() }).strict();

/*
 * §5 — "Drill in to the records behind it." What is recorded is that somebody
 * did, and over how many records; the records themselves are fetched by asking
 * the query layer, with that person's own permissions.
 */
export const recordDrill = z
  .object({
    resultRef: z.string().min(1).max(128),
    fieldPath: z.string().min(1).max(256),
    records: z.number().int().min(0).max(1_000_000),
  })
  .strict();

/* §6 — which of the three flags somebody opened, and on what. */
export const recordFlagOpened = z
  .object({
    resultRef: z.string().min(1).max(128),
    flagKind: z.enum(['disagreement', 'extraction', 'incompleteness']),
    subject: z.string().min(1).max(256),
  })
  .strict();
