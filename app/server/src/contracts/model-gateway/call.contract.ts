// A model call (spec 7.8, 62.1 to 62.3): the only way any Silo service reaches a model.
//
// The request is typed vocabulary, never free-form context. It may carry what spec 62.1
// permits: names the reader can see (object types, properties, link types, Action types,
// functions, source fields), descriptions and documentation written for the schema,
// declared capabilities, profiles as counts, the question, calendar context, and for
// ranking a findings summary that names every field it copies. There is nowhere to put a
// record value: no sample, example or distinct value, no row. The gateway builds the
// prompt from these parts itself.
//
// The caller states the output it expects as a JSON Schema (outputSpec turns its Zod
// schema into one). The gateway checks the model's output against it and refuses output
// that does not match; it never repairs it (spec 62.3). The caller parses the output
// again with its own Zod schema (parseOutput).
//
// Not keyed: every request is a new, separately recorded call, and the service client
// never repeats an unkeyed POST.

import { z } from 'zod';
import type { ServiceName } from '../../config/service.config.ts';
import { AppError } from '../../utils/errors.util.ts';
import { defineContract } from '../endpoint.contract.ts';

/** The roles a vocabulary request may use, each with its route (MODEL_ROUTES_FILE). */
export const VOCABULARY_ROLES = ['compile', 'compile_advanced', 'resolution', 'recognition', 'fde', 'connector_generation'] as const;
export type VocabularyRole = (typeof VOCABULARY_ROLES)[number];

/** Which services may use which role. A service outside a role's list is refused. */
export const ROLE_CALLERS: Readonly<Record<VocabularyRole, readonly ServiceName[]>> = {
  compile: ['compile', 'ask'],
  compile_advanced: ['compile', 'ask'],
  resolution: ['resolution', 'fde-orchestrator'],
  recognition: ['recognition'],
  fde: ['fde-orchestrator'],
  connector_generation: ['connector-builder', 'connect-registry', 'fde-orchestrator'],
};

export const MODEL_CALLERS: readonly ServiceName[] = [...new Set(Object.values(ROLE_CALLERS).flat())];

// Names in the organisation's own words: bounded, never values.
const name = z.string().min(1).max(200);
const description = z.string().max(2000);
const typeName = z.string().min(1).max(64);
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max);

const property = z.strictObject({
  name,
  type: typeName,
  description: description.optional(),
  /** Field aliases and field maps in the organisation's words (spec 62.1). */
  aliases: list(name, 20).optional(),
});

/** Spec 62.1: everything a prompt may contain about the reader's world, nothing more. */
export const vocabulary = z.strictObject({
  objectTypes: list(z.strictObject({
    name,
    description: description.optional(),
    properties: list(property, 500),
    /** The declared time fields, so the model can recognise a period (spec 26.4). */
    timeFields: list(name, 50).optional(),
  }), 500).optional(),
  linkTypes: list(z.strictObject({ name, from: name, to: name, route: name.optional(), description: description.optional() }), 1000).optional(),
  /** Interfaces (21.9): a shared shape several object types implement, named by its shared properties. A plan may stand on one, without links. */
  interfaces: list(z.strictObject({
    name, description: description.optional(), properties: list(property, 200), implementedBy: list(name, 500),
  }), 200).optional(),
  actionTypes: list(z.strictObject({
    name, description: description.optional(), parameters: list(z.strictObject({ name, type: typeName }), 100),
  }), 500).optional(),
  functions: list(z.strictObject({ name, signature: z.string().min(1).max(500), description: description.optional() }), 500).optional(),
  /** Source field names not denied by field policy. */
  sourceFields: list(z.strictObject({
    connection: name, object: name, field: name, type: typeName, description: description.optional(),
  }), 5000).optional(),
  /** What each contributing connection declares it can push down. */
  capabilities: list(z.strictObject({
    connection: name, operations: list(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), 100),
  }), 200).optional(),
  /** Field profiles as counts. The profile has nowhere to put a value. */
  profiles: list(z.strictObject({
    object: name,
    field: name.optional(),
    rowCount: z.int().min(0).optional(),
    distinctCount: z.int().min(0).optional(),
    nullRate: z.number().min(0).max(1).optional(),
  }), 5000).optional(),
  /** Documentation written for the schema, not for the records. */
  documentation: list(z.strictObject({ title: name, text: z.string().min(1).max(20_000) }), 100).optional(),
});

/** Ranking (spec 62.3): figures from the named fields only, so none reaches the model by omission. */
export const findingsSummary = z.strictObject({
  copiedFields: list(z.strictObject({ objectType: name, property: name }), 100),
  findings: list(z.strictObject({
    detector: name,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    count: z.int().min(0),
    score: z.number().optional(),
    /** Keyed "Object type.property", each one listed in copiedFields. Numbers only. */
    metrics: z.record(z.string().min(3).max(401), z.number()).optional(),
  }), 500),
});

/** What the model is told about time: never period arithmetic, only recognition (spec 26.4, 26.8). */
export const calendarContext = z.strictObject({
  today: z.iso.date().optional(),
  timeZone: z.string().min(1).max(64).optional(),
  fiscalYearStartMonth: z.int().min(1).max(12).optional(),
  weekStartsOn: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']).optional(),
});

/** The output contract: a JSON Schema from the caller's Zod schema. */
export const outputContract = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  schema: z.record(z.string(), z.json()),
});

export const usage = z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0), thinkingTokens: z.int().min(0) });

export const modelCallResult = z.object({
  callId: z.uuid(),
  /** The model's output, already checked against the output contract. */
  output: z.json(),
  model: z.string(),
  route: z.string(),
  usage,
  latencyMs: z.int().min(0),
});

export const callModel = defineContract({
  service: 'model-gateway', name: 'callModel', method: 'POST', path: '/v1/calls',
  callers: MODEL_CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    role: z.enum(VOCABULARY_ROLES),
    /** The task, constant text written in the caller's code. Scanned like everything else. */
    instructions: z.string().min(1).max(32_000),
    vocabulary,
    /** Length-bounded: a model is charged by the token (spec 26.4). */
    question: z.string().min(1).max(2000).optional(),
    context: calendarContext.optional(),
    findingsSummary: findingsSummary.optional(),
    output: outputContract,
    maxOutputTokens: z.int().min(1).max(1_000_000).optional(),
    /** AI FDE work: the engagement and task the call is for (spec 52.6). */
    engagementId: z.uuid().optional(),
    taskId: z.uuid().optional(),
  }),
  response: modelCallResult,
  maxBodyBytes: 1024 * 1024,
});

/** The output contract for a Zod schema, as a caller sends it. */
export function outputSpec(outputName: string, schema: z.ZodType): z.input<typeof outputContract> {
  return { name: outputName, schema: z.toJSONSchema(schema, { io: 'output' }) as Record<string, z.core.util.JSONType> };
}

/** The caller's own check of the output: Zod on both sides (spec 7.1). */
export function parseOutput<S extends z.ZodType>(schema: S, output: unknown): z.output<S> {
  const parsed = schema.safeParse(output);
  if (parsed.success) return parsed.data;
  throw new AppError('upstream', 'the model output does not match the caller\'s schema', {
    code: 'model.output_invalid', details: { issues: parsed.error.issues.length },
  });
}
