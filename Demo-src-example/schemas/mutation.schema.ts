import { z } from 'zod';

/**
 * Mutations at the door.
 *
 * ── Rejected, never repaired ───────────────────────────────────────────────
 *
 * §3: "Zod validated, rejected rather than repaired, exactly as a query manifest
 * is." Every object is strict, so a key the caller meant and misspelt is a 400
 * naming it rather than a default the change was then made under.
 *
 * ── Concept terms only ─────────────────────────────────────────────────────
 *
 * There is no field here for a connection, an object or a column. The user says
 * what should change; the ontology decides where. A body that could name a table
 * would be a second write path beside the governed one.
 */

const scalar = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);

const filter = z
  .object({
    field: z.string().min(1).max(256),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null']),
    value: z.unknown().optional(),
  })
  .strict();

export const proposeMutation = z
  .object({
    /* §12 — the receipt carries the intent in the user's own words. */
    intent: z.string().trim().min(1).max(2000),
    manifest: z
      .object({
        conceptId: z.string().uuid(),
        operation: z.enum(['update', 'delete']),
        /*
         * THE ENTITY SET IS BOUNDED, BY FILTERS OR BY NAMED RECORDS. A change
         * to every record of a concept is a real thing to want and a
         * catastrophic thing to send by omission; it is made by saying which
         * records, and the bulk guardrails then apply to it.
         *
         * `where` used to carry `.min(1)` alone. Rendering §5 — "act on it,
         * entering the mutation path WITH THE SELECTION AS THE TARGET" — means
         * a caller can now say which records by naming them, so the guard moved
         * to the refinement below and asks the question it was always asking:
         * is this bounded by anything at all.
         */
        where: z.array(filter).max(50).default([]),
        /*
         * Rendering §5 — the records somebody selected, by the identifier their
         * own system states.
         *
         * A HUNDRED, WHICH IS THE BULK TIER. Beyond that a person is not
         * selecting, they are filtering, and a filter is the honest way to say
         * it — it re-evaluates at write time and the preview shows what it
         * reached.
         */
        targets: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
        set: z.record(z.string().min(1).max(256), scalar).default({}),
        /* §7 — strict unless this mutation says otherwise. There is no other place to say it. */
        resolution: z.enum(['strict', 'partial']).default('strict'),
      })
      .strict()
      .superRefine((manifest, ctx) => {
        if (manifest.where.length === 0 && (manifest.targets?.length ?? 0) === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['where'],
            message: 'Say which records this changes, by a filter or by naming them.',
          });
        }

        const fields = Object.keys(manifest.set).length;
        if (manifest.operation === 'update' && fields === 0) {
          ctx.addIssue({ code: 'custom', path: ['set'], message: 'Say which fields change, and to what.' });
        }
        if (manifest.operation === 'delete' && fields > 0) {
          ctx.addIssue({ code: 'custom', path: ['set'], message: 'A delete sets no fields.' });
        }
        if (fields > 100) {
          ctx.addIssue({ code: 'custom', path: ['set'], message: 'At most 100 fields change at once.' });
        }
      }),
  })
  .strict();

/*
 * §3 — a change in the user's own words. The history is the conversation so far,
 * so "and the other one" can be compiled; it carries words, never records.
 */
export const compileChange = z
  .object({
    intent: z.string().trim().min(1).max(2000),
    history: z
      .array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(4000) }).strict())
      .max(20)
      .optional(),
  })
  .strict();

export const mutationId = z.object({ id: z.string().uuid() }).strict();

export const listMutations = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /* `awaiting_approval` is the approvals queue. */
    status: z
      .enum([
        'previewed', 'awaiting_approval', 'approved', 'rejected',
        'executing', 'canary_paused', 'executed', 'partially_executed', 'failed',
      ])
      .optional(),
  })
  .strict();

/* §9 — a rejection carries its reason; an approval may. */
const comment = z.string().trim().min(1).max(1000);

export const approveMutation = z.object({ comment: comment.optional() }).strict();

export const rejectMutation = z.object({ comment }).strict();

/*
 * THE TERMS, ALL OF THEM, EVERY TIME. A policy sent with a term missing and
 * defaulted here would be a weaker rule than the sender meant whenever the
 * default is the weak answer, so nothing defaults.
 */
const terms = z
  .object({
    approvalsRequired: z.number().int().min(1).max(5),
    requiredRoleId: z.string().uuid().nullable(),
    allowSelfApproval: z.boolean(),
    separateExecution: z.boolean(),
    expiresAfterHours: z.number().int().min(1).max(24),
  })
  .strict();

export const connectionParams = z.object({ connectionId: z.string().uuid() }).strict();

export const setPolicy = z.object({ scopeId: z.string().uuid().nullable(), terms }).strict();

export const setDefaultPolicy = z.object({ terms }).strict();

export const policyScope = z.object({ scopeId: z.string().uuid().optional() }).strict();

export const setFloor = z.object({ terms }).strict();

export const setAuthority = z
  .object({
    authority: z.enum(['owner_set', 'delegated', 'locked']),
    grantedTo: z.string().uuid().nullable(),
  })
  .strict();

/*
 * §13 — WHAT TO DO WITH EACH FIELD SOMEBODY CHANGED SINCE. A conflict with no
 * choice here is left alone; there is no "revert everything" switch, because
 * overwriting a colleague's change should be a decision made about that change.
 */
export const requestRevert = z
  .object({
    intent: z.string().trim().min(1).max(2000),
    choices: z
      .array(
        z
          .object({
            connectionId: z.string().uuid(),
            ref: z.string().min(1).max(1000),
            field: z.string().min(1).max(256),
            choice: z.enum(['revert', 'keep']),
          })
          .strict(),
      )
      .max(10_000)
      .default([]),
  })
  .strict();

/* How long receipts are kept: never past the 730 days the schema allows. */
export const setRetention = z.object({ receiptDays: z.number().int().min(1).max(730) }).strict();

export const changesPage = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
