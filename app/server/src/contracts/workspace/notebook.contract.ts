// Notebooks (D239; beyond the spec: the notebooks of the Foundry-comparison features). A notebook
// is an analysis written as cells, in order: text a person writes, and cells that each make a
// table or read one. An objects cell reads a saved object set's chosen properties; a question cell
// is a plain-language question compiled once (charged once, by compile) into a plan kept with the
// values it bound, sealed; a transform cell runs the closed steps of a pipeline (CEL, evaluated by
// the expression evaluator within bounds) over an earlier table, joining others by name; a
// statistics cell summarises an earlier table's columns; a chart cell draws one; a predict cell
// (D242) scores a set's objects with a published model, as a model's predictions are made (the
// reader holding every marking the model learnt under), giving each object's id, prediction and
// confidence, joinable to an objects cell that adds its objects' ids. There is no code to run: no
// sandbox, nothing that reaches outside the cell's own bounds.
//
// Everything a cell reads is read for whoever runs the notebook, as them, when they run it: a set
// or plan they may not read is refused with why, a property they may not see is left blank, and
// nothing read is ever stored. A question's own words are a record value (36.8): a question cell
// keeps the plan and the label its owner gives it, never the question. Shared like a workbook
// (37.4: the owner's policy as ceiling), to open or to copy; only the owner edits. Exported into
// Files as a spreadsheet of its tables as computed for the exporter, with the markings of what they
// read.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { fileView } from '../files/file.contract.ts';
import { recordValue } from '../../utils/recordValue.util.ts';
import { pipelineStep } from './pipeline.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;
const cellId = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A table's name: later cells read it by this name, and a join names it. */
const tableName = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
const column = z.string().min(1).max(100);

export const notebookCell = z.discriminatedUnion('kind', [
  z.strictObject({ id: cellId, kind: z.literal('text'), text: z.string().max(20_000) }),
  z.strictObject({
    id: cellId, kind: z.literal('objects'), name: tableName,
    objectSetId: z.uuid(), propertyIds: z.array(z.uuid()).min(1).max(30), limit: z.int().min(1).max(50_000).default(1_000),
    /** Each object's Silo id first, as object_id, to join predictions to (D242). */
    withIds: z.boolean().default(false),
  }),
  z.strictObject({
    id: cellId, kind: z.literal('question'), name: tableName,
    /** The owner's own words for what it asks: the question itself is never kept. */
    label: z.string().trim().min(1).max(200),
    /** The compiled plan, once asked; its bound values are kept sealed under bindingId. */
    planId: z.uuid().nullable(),
    bindingId: z.uuid(),
  }),
  z.strictObject({ id: cellId, kind: z.literal('transform'), name: tableName, input: tableName, steps: z.array(pipelineStep).min(1).max(30) }),
  z.strictObject({ id: cellId, kind: z.literal('stats'), source: tableName, columns: z.array(column).max(20).default([]) }),
  z.strictObject({
    id: cellId, kind: z.literal('predict'), name: tableName, mlModelId: z.uuid(),
    /** The objects scored: the model's own set when null, else another set of its type. */
    objectSetId: z.uuid().nullable().default(null), limit: z.int().min(1).max(5_000).default(500),
  }),
  z.strictObject({
    id: cellId, kind: z.literal('chart'), source: tableName, chart: z.enum(['bar', 'line', 'scatter', 'histogram']),
    x: column,
    /** bar: summed per x (absent: counted); line and scatter: plotted against x; histogram: none. */
    y: column.nullable().default(null),
    bins: z.int().min(2).max(100).default(20),
  }),
]);
export type NotebookCell = z.infer<typeof notebookCell>;

export const notebookDocument = z.strictObject({
  schemaVersion: z.literal('1'),
  cells: z.array(notebookCell).max(60),
}).superRefine((d, ctx) => {
  const ids = new Set<string>();
  const tables = new Set<string>();
  d.cells.forEach((c, i) => {
    if (ids.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cells', i, 'id'], message: 'each cell has its own id' });
    ids.add(c.id);
    const reads = c.kind === 'transform' ? [c.input, ...c.steps.flatMap((s) => (s.op === 'join' ? [s.input] : []))] : c.kind === 'stats' || c.kind === 'chart' ? [c.source] : [];
    for (const name of reads) if (!tables.has(name)) ctx.addIssue({ code: 'custom', path: ['cells', i], message: `${name} is not a table made by an earlier cell` });
    if ('name' in c) {
      if (tables.has(c.name)) ctx.addIssue({ code: 'custom', path: ['cells', i, 'name'], message: `two cells make ${c.name}` });
      tables.add(c.name);
    }
  });
});
export type NotebookDocument = z.infer<typeof notebookDocument>;

const access = z.enum(['owner', 'view', 'copy']);
export const notebookSummary = z.object({
  id: z.uuid(), name: z.string(), ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export const notebookView = notebookSummary.extend({ document: notebookDocument });
export type NotebookView = z.infer<typeof notebookView>;

const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const tableOutput = z.object({
  kind: z.literal('table'), columns: z.array(z.string()), rows: recordValue(z.array(z.array(value))), total: z.int(), truncated: z.boolean(),
  /** Properties the reader may not see: blank. */
  withheld: z.int(),
  /** What the reader should know of it: for predictions, how far the objects have drifted from what the model learnt from. */
  note: z.string().nullable().default(null),
});
export const columnStats = z.object({
  name: z.string(), count: z.int(), empty: z.int(), distinct: z.int(),
  numeric: z.object({ min: z.number(), max: z.number(), mean: z.number(), median: z.number(), p90: z.number(), stddev: z.number() }).nullable(),
  /** The most frequent values, as the reader sees them. */
  top: recordValue(z.array(z.object({ value, count: z.int() }))),
});
export const cellOutput = z.object({
  cellId: z.string(),
  /** Why the cell could not be computed for the reader, with nothing shown; null when it was. */
  refused: z.string().nullable(),
  output: z.discriminatedUnion('kind', [
    tableOutput,
    z.object({ kind: z.literal('stats'), columns: z.array(columnStats) }),
    z.object({
      kind: z.literal('chart'),
      /** bar: categories and values; line and scatter: points; histogram: bins and counts. */
      bars: recordValue(z.array(z.object({ label: z.string(), value: z.number() }))).optional(),
      points: recordValue(z.array(z.tuple([z.number(), z.number()]))).optional(),
      bins: z.array(z.object({ from: z.number(), to: z.number(), count: z.int() })).optional(),
      /** Rows left out: not a number where one is drawn, or past the bound. */
      omitted: z.int(),
    }),
  ]).nullable(),
});
export type CellOutput = z.infer<typeof cellOutput>;

export const notebookShareView = z.object({
  id: z.uuid(), notebookId: z.uuid(), grantee: shareGrantee, access: z.enum(['view', 'copy']), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ notebookId: z.uuid() });
const name = z.string().trim().min(1).max(200);

export const createNotebook = defineContract({
  service: 'workspace', name: 'createNotebook', method: 'POST', path: '/v1/notebooks', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: z.strictObject({ name }), response: notebookView, status: 201,
});

export const listNotebooks = defineContract({
  service: 'workspace', name: 'listNotebooks', method: 'GET', path: '/v1/notebooks', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ notebooks: z.array(notebookSummary) }),
});

export const getNotebook = defineContract({
  service: 'workspace', name: 'getNotebook', method: 'GET', path: '/v1/notebooks/:notebookId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: notebookView,
});

/** The owner's edit: each objects cell over a set and properties the owner may see; each question cell's plan one the owner compiled for it. */
export const saveNotebook = defineContract({
  service: 'workspace', name: 'saveNotebook', method: 'PUT', path: '/v1/notebooks/:notebookId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ name: name.optional(), document: notebookDocument, lockVersion: z.int().min(1) }),
  response: notebookView, maxBodyBytes: 1024 * 1024,
});

/**
 * A question cell asked (the owner): compiled by compile, which charges it, into a plan whose bound
 * values are sealed under the cell's binding. A plan is saved into the cell; a clarification is
 * answered by asking again with the candidate chosen; a refusal says what would work.
 */
export const askNotebookQuestion = defineContract({
  service: 'workspace', name: 'askNotebookQuestion', method: 'POST', path: '/v1/notebooks/:notebookId/questions', callers: CALLERS,
  shed: 'compile', context: 'organisation', idempotency: 'keyed', params,
  body: z.strictObject({
    cellId,
    question: recordValue(z.string().trim().min(1).max(2_000)),
    chosen: z.strictObject({
      option: z.object({ id: z.string(), kind: z.string(), elementId: z.uuid(), label: z.string(), source: z.string().nullable() }),
      rejected: z.array(z.object({ id: z.string(), kind: z.string(), elementId: z.uuid(), label: z.string(), source: z.string().nullable() })).max(20),
    }).optional(),
    lockVersion: z.int().min(1),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('plan'), notebook: notebookView, tokensCharged: z.int() }),
    z.object({ outcome: z.literal('clarification'), options: z.array(z.object({ id: z.string(), kind: z.string(), elementId: z.uuid(), label: z.string(), source: z.string().nullable() })) }),
    z.object({ outcome: z.literal('refusal'), reason: z.string(), narrowing: z.string().nullable() }),
  ]),
  status: 201,
});

/** Every cell computed now for the caller, in order: nothing read is stored. A document the owner has not saved is run by the owner alone. */
export const runNotebook = defineContract({
  service: 'workspace', name: 'runNotebook', method: 'POST', path: '/v1/notebooks/:notebookId/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ document: notebookDocument.optional() }),
  response: z.object({ outputs: z.array(cellOutput), computedAt: z.string() }), status: 201, maxBodyBytes: 1024 * 1024,
});

export const copyNotebook = defineContract({
  service: 'workspace', name: 'copyNotebook', method: 'POST', path: '/v1/notebooks/:notebookId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ name }), response: notebookView, status: 201,
});

export const archiveNotebook = defineContract({
  service: 'workspace', name: 'archiveNotebook', method: 'POST', path: '/v1/notebooks/:notebookId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: notebookView,
});

export const shareNotebook = defineContract({
  service: 'workspace', name: 'shareNotebook', method: 'POST', path: '/v1/notebooks/:notebookId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(['view', 'copy']), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: notebookShareView, status: 201,
});

export const revokeNotebookShare = defineContract({
  service: 'workspace', name: 'revokeNotebookShare', method: 'POST', path: '/v1/notebooks/:notebookId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ notebookId: z.uuid(), shareId: z.uuid() }), response: notebookShareView,
});

export const listNotebookShares = defineContract({
  service: 'workspace', name: 'listNotebookShares', method: 'GET', path: '/v1/notebooks/:notebookId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(notebookShareView) }),
});

/** Into Files: a sheet per table as computed now for the exporter, with the markings of what they read. */
export const exportNotebook = defineContract({
  service: 'workspace', name: 'exportNotebook', method: 'POST', path: '/v1/notebooks/:notebookId/exports', callers: CALLERS,
  shed: 'export_render', context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ folderId: z.uuid().optional() }),
  response: z.object({ file: fileView }), status: 201,
});
