import { z } from 'zod';
import {
  FINDING_OPERATORS,
  RESULT_OPERATORS,
  VALUE_OPERATORS,
} from '../models/automationCondition.model';
import { DETECTORS } from '../models/finding.model';

/**
 * Automations §2 and §3 — a schedule, conditions, and a notify action.
 *
 * ONLY THE OPERATORS THE ENGINE EVALUATES ARE ACCEPTED, taken from the model
 * rather than restated. §14 adds finding and value conditions in later steps,
 * and a schema that accepted them early would store an automation whose
 * condition nothing can answer — which looks identical to one that is simply
 * never true.
 *
 * FOUR CONDITIONS, NOT TEN. §3 bounds composition at a small depth and says
 * "anything deeper is a question, not a condition, and belongs in the saved
 * question instead". The table allows ten; the door allows four, because the
 * limit that matters is the one a person can still read back.
 */

/*
 * TWO SHAPES, DISCRIMINATED, RATHER THAN ONE WITH EVERY FIELD OPTIONAL. A
 * result condition takes a number; a finding condition takes a detector name
 * and sometimes a floor. Collapsing them into one loose object would accept
 * `{ operator: 'any_rows', target: 'outlier' }` — a sentence with no meaning
 * that the service would then have to refuse at a worse moment.
 */
const resultCondition = z
  .object({
    kind: z.literal('result').default('result'),
    operator: z.enum(RESULT_OPERATORS),
    value: z.number().int().min(0).max(1_000_000).optional(),
    combinator: z.enum(['and', 'or']).default('and'),
  })
  .strict();

const findingCondition = z
  .object({
    kind: z.literal('finding'),
    operator: z.enum(FINDING_OPERATORS),
    /** Which of the ten checks. Omitted means any of them. */
    target: z.enum(DETECTORS).nullable().default(null),
    /** A score floor, or how many times it has been raised. */
    value: z.number().min(0).max(1_000_000).optional(),
    combinator: z.enum(['and', 'or']).default('and'),
  })
  .strict();

/*
 * §3 — "Evaluated against a single figure the question returns." `target` names
 * which total, by its field path, and may be omitted only where the question
 * returns exactly one. `value` is a threshold, a proportion (0.1 being ten per
 * cent) or a number of days, depending on the operator.
 */
const valueCondition = z
  .object({
    kind: z.literal('value'),
    operator: z.enum(VALUE_OPERATORS),
    target: z.string().min(1).max(256).nullable().default(null),
    value: z.number().min(0).max(1_000_000_000),
    combinator: z.enum(['and', 'or']).default('and'),
  })
  .strict();

const condition = z.union([findingCondition, valueCondition, resultCondition]);

/*
 * §5 — the four things execute-within-bounds requires, and all four are
 * required. Three of them is none: a row limit with no field list bounds how
 * much damage rather than what kind, and a field list with no expiry bounds it
 * forever.
 *
 * ONE SHAPE BEHIND TWO DOORS. This is the body of
 * `POST /automations/:id/authorisation` and it is `mutate.execute` on creation,
 * because §5 says the bounds are "set at creation" and a second spelling of
 * them somewhere else would be a second set of limits to keep in agreement
 * with this one.
 */
export const authoriseExecution = z
  .object({
    maxRows: z.number().int().min(1).max(100),
    permittedFields: z.array(z.string().min(1).max(256)).min(1).max(50),
    permittedConnections: z.array(z.string().uuid()).min(1).max(50),
    expiresAt: z.coerce.date(),
  })
  .strict();

export const createAutomation = z
  .object({
    name: z.string().trim().min(1).max(128),
    /* §3 — omitted where the automation watches the checks rather than a
       question, which is the case with "no question to author at all". */
    savedViewId: z.string().uuid().nullable().default(null),
    /** Narrows the checks to one concept. Findings automations only. */
    conceptId: z.string().uuid().nullable().default(null),
    /* Five fields. Validated properly by the parser in the service. */
    schedule: z.string().trim().min(9).max(128),
    conditions: z.array(condition).max(4).default([]),
    notify: z
      .object({ email: z.string().email().max(320).nullable().default(null) })
      .strict()
      .nullable()
      .default({ email: null }),
    /*
     * §5 — BOTH MODES, AND STILL NO MODE FIELD. The mode is whether the bounds
     * are here: `execute` present is execute-within-bounds, absent is propose,
     * which §5 calls the default. A `mode: 'execute_within_bounds'` string
     * beside them could say execute while naming no bounds, or name bounds
     * while saying propose — two ways of writing a sentence somebody would then
     * have to rule on, at a worse moment.
     *
     * WHY THE BOUNDS MOVED HERE, having been deliberately kept out. This said
     * they belonged on a separate request because creating an automation and
     * authorising it to write unattended are two acts. They still are: §10's
     * `automation.execute` is asserted apart from `automation.create`, the
     * bounds are still written to their own immutable row, and the trail still
     * records `automation_authorised` as its own event. What was wrong was the
     * reading of §5 — "only inside limits set WHEN THE AUTOMATION WAS CREATED",
     * and "set at creation and unchangeable by the automation itself". That is
     * two decisions in one act, not two requests, and a person filling in one
     * form should not have to send the second one to get the first one's
     * promise. `POST /automations/:id/authorisation` remains, for a check
     * created in propose mode and for authorising again after a withdrawal.
     *
     * `intent` IS REQUIRED because the mutation path records what was asked in
     * the requester's own words beside what it compiled to, and an automation
     * that proposed changes with no stated intent would put unexplained work
     * into somebody's approval queue every morning.
     */
    mutate: z
      .object({
        intent: z.string().trim().min(1).max(500),
        operation: z.enum(['update', 'delete']),
        set: z
          .record(z.string().min(1).max(256), z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]))
          .default({}),
        resolution: z.enum(['strict', 'partial']).default('strict'),
        /* §5 — the limits, and nested so that bounds without a change to bound
           cannot be sent at all. */
        execute: authoriseExecution.nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    /*
     * §4 — "Raise it to a named membership or scope for a decision. A notify
     * that requires acknowledgement rather than one that can be ignored."
     *
     * EXACTLY ONE TARGET, AND THAT RULE IS NOT HERE. The shape admits both keys
     * and the service refuses anything but one of them, in the same place it
     * refuses a mutate action with nothing to change — the schema says what the
     * words are, the service says which sentences mean anything. Escalate needs
     * no permission of its own: §10 gives none, and it writes nothing.
     */
    escalate: z
      .object({
        membershipId: z.string().uuid().nullable().default(null),
        scopeId: z.string().uuid().nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    /*
     * §4 — "Produce an export and put it in Files, with the permissions of
     * whoever owns the automation."
     *
     * TWO FORMATS, BECAUSE FILES HAS TWO. `file.service`'s `ExportFormat` is
     * json or csv, and offering a third here would be a stored automation whose
     * every run fails on the format it was created with.
     */
    report: z
      .object({ format: z.enum(['json', 'csv']).default('csv') })
      .strict()
      .nullable()
      .default(null),
    failurePolicy: z.enum(['notify_and_continue', 'pause_after_failures']).default('notify_and_continue'),
    pauseAfter: z.number().int().min(1).max(100).nullable().default(null),
  })
  .strict();

export const automationId = z.object({ id: z.string().uuid() }).strict();

export const escalationId = z.object({ id: z.string().uuid() }).strict();

/** §4 — an answer may carry a note. It is a decision, and decisions have reasons. */
export const acknowledgeEscalation = z
  .object({ note: z.string().trim().min(1).max(2000).nullable().default(null) })
  .strict();
