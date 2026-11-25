// Data pipelines (D235; beyond the spec: the pipelines of the Foundry-comparison features). A
// pipeline reads object sets as the person who runs it, transforms them step by step (filter,
// compute, select, join, aggregate, dedupe, sort, limit: services/workspace/pipelineEngine), and
// writes the result as a CSV file into an Import Silo source, from where it is read through the
// Silo's own connection like any other data: mapped into the ontology, captured, governed. Silo
// still holds no copy of its own: the output is the customer's, in a Silo they chose, with its
// retention. A run writes only into a Silo marked at least as its inputs are, so a pipeline never
// declassifies. Previews run the same steps and keep nothing.
//
// A schedule (D241) runs a pipeline unattended: as its own service principal (kind automation,
// owned by the pipeline's owner), granted read on the connections its inputs read and silo.import,
// both bounded by the owner at every run, so it never reads or writes more than they could now.
// Missed times are not backfilled (the run says how many it skipped); after the failures it
// allows in a row it pauses, and its owner is told of each failed run.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
const column = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const cel = z.string().trim().min(1).max(2_000);

export const pipelineInput = z.strictObject({
  /** The input's name: a join names it, and its columns are prefixed with it when joined. */
  id: slug,
  objectSetId: z.uuid(),
  propertyIds: z.array(z.uuid()).min(1).max(50),
  limit: z.int().min(1).max(50_000).default(10_000),
});

export const pipelineStep = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('filter'), cel }),
  z.strictObject({ op: z.literal('compute'), as: column, cel }),
  z.strictObject({ op: z.literal('select'), columns: z.array(z.strictObject({ from: z.string().min(1).max(100), as: column.optional() })).min(1).max(100) }),
  z.strictObject({ op: z.literal('join'), input: slug, on: z.array(z.tuple([z.string().min(1).max(100), z.string().min(1).max(100)])).min(1).max(5), kind: z.enum(['inner', 'left']) }),
  z.strictObject({
    op: z.literal('aggregate'), by: z.array(z.string().min(1).max(100)).max(10),
    measures: z.array(z.strictObject({ as: column, fn: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']), column: z.string().min(1).max(100).optional() })).min(1).max(20),
  }),
  z.strictObject({ op: z.literal('dedupe'), by: z.array(z.string().min(1).max(100)).max(20) }),
  z.strictObject({ op: z.literal('sort'), by: z.array(z.strictObject({ column: z.string().min(1).max(100), direction: z.enum(['asc', 'desc']) })).min(1).max(5) }),
  z.strictObject({ op: z.literal('limit'), rows: z.int().min(1).max(200_000) }),
]);

export const pipelineOutput = z.strictObject({
  siloId: z.uuid(), sourceId: z.uuid(), filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,115}\.csv$/),
});

export const pipelineDocument = z.strictObject({
  schemaVersion: z.literal('1'),
  inputs: z.array(pipelineInput).min(1).max(5),
  steps: z.array(pipelineStep).max(50),
  output: pipelineOutput.optional(),
}).refine((d) => new Set(d.inputs.map((i) => i.id)).size === d.inputs.length, 'each input has its own name');
export type PipelineDocument = z.infer<typeof pipelineDocument>;

/** What a scheduled pipeline's principal is granted besides read on its inputs' connections (policy): writing its output. Its owner bounds it. */
export const PIPELINE_PRINCIPAL_PERMISSIONS = ['silo.import'] as const;

export const pipelineScheduleView = z.object({
  schedule: z.string(), timeZone: z.string(), status: z.enum(['active', 'paused']), pausedReason: z.enum(['failures', 'archived']).nullable(),
  nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), failuresInARow: z.int(), pauseAfterFailures: z.int(), servicePrincipalId: z.uuid(),
});
export type PipelineScheduleView = z.infer<typeof pipelineScheduleView>;

export const pipelineView = z.object({
  id: z.uuid(), name: z.string(), ownerMembershipId: z.uuid(), document: pipelineDocument,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
  schedule: pipelineScheduleView.nullable(),
});

export const pipelineRunView = z.object({
  id: z.uuid(), pipelineId: z.uuid(), status: z.enum(['running', 'completed', 'failed']), rows: z.int().nullable(), siloFileId: z.uuid().nullable(),
  failure: z.string().nullable(),
  /** A person, or the schedule (startedBy then null). */
  trigger: z.enum(['person', 'schedule']), startedBy: z.uuid().nullable(), startedAt: z.string(), finishedAt: z.string().nullable(),
});

/** What the steps make of the inputs now, as the caller may read them: the columns, the first rows, and where a step failed. */
export const pipelinePreview = z.object({
  columns: z.array(z.string()),
  rows: recordValue(z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))),
  total: z.int(),
  inputs: z.array(z.object({ id: z.string(), rows: z.int(), truncated: z.boolean(), withheld: z.int(), refused: z.string().nullable() })),
  failedStep: z.object({ step: z.int(), message: z.string() }).nullable(),
});

const params = z.strictObject({ pipelineId: z.uuid() });
const name = z.string().trim().min(1).max(200);

export const createPipeline = defineContract({
  service: 'workspace', name: 'createPipeline', method: 'POST', path: '/v1/pipelines', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: z.strictObject({ name, document: pipelineDocument }), response: pipelineView, status: 201,
});

export const listPipelines = defineContract({
  service: 'workspace', name: 'listPipelines', method: 'GET', path: '/v1/pipelines', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ archived: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ pipelines: z.array(pipelineView.omit({ document: true })) }),
});

export const getPipeline = defineContract({
  service: 'workspace', name: 'getPipeline', method: 'GET', path: '/v1/pipelines/:pipelineId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: pipelineView,
});

export const savePipeline = defineContract({
  service: 'workspace', name: 'savePipeline', method: 'PUT', path: '/v1/pipelines/:pipelineId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ name: name.optional(), document: pipelineDocument, lockVersion: z.int().min(1) }),
  response: pipelineView,
});

/** The steps run over the inputs as the caller reads them, nothing written: a draft document may be previewed before it is saved. */
export const previewPipeline = defineContract({
  service: 'workspace', name: 'previewPipeline', method: 'POST', path: '/v1/pipelines/:pipelineId/previews', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ document: pipelineDocument.optional() }),
  response: pipelinePreview,
});

/** A run by the owner: inputs read as them, the steps run, the CSV written into the output Silo source. */
export const runPipeline = defineContract({
  service: 'workspace', name: 'runPipeline', method: 'POST', path: '/v1/pipelines/:pipelineId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, response: pipelineRunView, status: 201,
});

export const listPipelineRuns = defineContract({
  service: 'workspace', name: 'listPipelineRuns', method: 'GET', path: '/v1/pipelines/:pipelineId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ runs: z.array(pipelineRunView) }),
});

/** One run of a pipeline the caller owns, by its id: what a failed run's notification opens (D268). */
export const getPipelineRun = defineContract({
  service: 'workspace', name: 'getPipelineRun', method: 'GET', path: '/v1/pipeline-runs/:runId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ runId: z.uuid() }), response: pipelineRunView,
});

/**
 * The pipeline run on a schedule (the owner, pipeline.save, holding silo.import on its output): five
 * fields in the organisation's time zone, no more often than every fifteen minutes. Its principal is
 * made with it; the connections its inputs read are granted it now and on every change.
 */
export const setPipelineSchedule = defineContract({
  service: 'workspace', name: 'setPipelineSchedule', method: 'PUT', path: '/v1/pipelines/:pipelineId/schedule', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({
    schedule: z.string().trim().regex(/^\S+(\s+\S+){4}$/, 'a schedule is five fields: minute hour day-of-month month day-of-week').max(200),
    pauseAfterFailures: z.int().min(1).max(20).default(3),
  }),
  response: pipelineView,
});

/** No longer scheduled: its principal revoked, its runs kept. */
export const removePipelineSchedule = defineContract({
  service: 'workspace', name: 'removePipelineSchedule', method: 'POST', path: '/v1/pipelines/:pipelineId/schedule/removal', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: pipelineView,
});

/** A paused schedule running again from its next time, its failures counted afresh. */
export const resumePipelineSchedule = defineContract({
  service: 'workspace', name: 'resumePipelineSchedule', method: 'POST', path: '/v1/pipelines/:pipelineId/schedule/resumption', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: pipelineView,
});

export const archivePipeline = defineContract({
  service: 'workspace', name: 'archivePipeline', method: 'POST', path: '/v1/pipelines/:pipelineId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: pipelineView,
});
