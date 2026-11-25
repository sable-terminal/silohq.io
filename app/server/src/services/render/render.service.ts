// render (spec 41.2): a compiled plan's answer, for the caller now, as a document in Files.
//
// 1. The plan, and its answer under the caller's own access (a member, or a Cron's
//    principal): the executor re-resolves that access, so the export holds only what the
//    caller may see. The data plane answers when the same plan ran for the same permissions
//    within its life, so a Cron's report is the answer its run saw.
// 2. Every page of the answer, within the executor's result bound.
// 3. Its lineage inputs: the object types and connections each column came from, and the
//    view it was saved as; files says which markings an export of them carries, to print.
// 4. The document (document.service, laid out by csv, xlsx or pdf), then files stores it with
//    those markings, its frozen permissions, provenance and lineage, or refuses if a marking
//    changed in between.

import type { z } from 'zod';
import { getCompiledPlan } from '../../contracts/compile/compile.contract.ts';
import { readResultPage, runPlan, type QueryResult } from '../../contracts/executor/result.contract.ts';
import { createExport, getExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import type { renderExport } from '../../contracts/render/render.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { FORMAT_FILES } from '../../contracts/render/render.contract.ts';
import { renderCsv } from './csv.service.ts';
import { exportDocument } from './document.service.ts';
import { renderPdf } from './pdf.service.ts';
import { renderXlsx } from './xlsx.service.ts';

export interface RenderDeps {
  services: ServiceClient;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'idempotencyKey'>;
type Input = z.output<typeof renderExport.body>;
type Output = z.output<typeof renderExport.response>;

async function allRows(deps: RenderDeps, result: QueryResult, options: { request: Context['request']; correlationId: string }): Promise<unknown[]> {
  const rows: unknown[] = result.kind === 'groups' ? [...result.page.groups] : [...result.page.objects];
  for (let index = 1; rows.length < result.total && result.page.count > 0; index += 1) {
    const page = await deps.services.call(readResultPage, { params: { queryId: result.queryId, page: index } }, options);
    const items = result.kind === 'groups' ? page.groups : page.objects;
    if (items.length === 0) break;
    rows.push(...items);
  }
  return rows;
}

function lineageInputs(input: Input, nodes: readonly { objectTypeId?: string | undefined }[], result: QueryResult): { node: NodeRef; relation: Relation }[] {
  const seen = new Map<string, { node: NodeRef; relation: Relation }>();
  const add = (node: NodeRef) => seen.set(`${node.kind}\u0000${node.refId}\u0000${node.version}`, { node, relation: 'exported_from' });
  for (const column of result.lineage) {
    const typeId = nodes[column.node]?.objectTypeId;
    if (typeId !== undefined) add({ kind: 'object_type_version', refId: typeId, version: column.objectTypeVersionId });
    for (const source of column.sources) add({ kind: 'connection', refId: source.connectionId, version: source.connectorVersion });
  }
  if (input.source.kind === 'view') add({ kind: 'view', refId: input.source.savedViewId, version: result.planHash });
  // A plan over an interface: the types that contributed (21.9).
  for (const c of result.contributingTypes ?? []) add({ kind: 'object_type_version', refId: c.objectTypeId, version: result.ontologyVersionId });
  if (seen.size === 0 && nodes[0]?.objectTypeId !== undefined) add({ kind: 'object_type_version', refId: nodes[0].objectTypeId, version: result.ontologyVersionId });
  return [...seen.values()];
}

export async function render(deps: RenderDeps, ctx: Context, input: Input): Promise<Output> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const stored = await deps.services.call(getCompiledPlan, { params: { planId: input.planId } }, options);
  const out = await deps.services.call(runPlan, {
    body: { plan: stored.plan, planId: stored.planId, trigger: input.source.kind === 'cron_report' ? 'cron_run' : 'saved_view_run', useCache: true },
  }, options);
  if (out.outcome === 'refusal') return { outcome: 'refused', code: out.refusal.code, reason: out.refusal.reason };
  const result = out.result;
  const rows = await allRows(deps, result, options);
  const inputs = lineageInputs(input, stored.plan.nodes, result);
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);

  const parts = { name: input.name, markings: markings.map((m) => m.name), plan: stored.plan, result, rows };
  const bytes = input.format === 'xlsx' ? renderXlsx(exportDocument(parts)) : input.format === 'pdf' ? renderPdf(exportDocument(parts))
    : Buffer.from(renderCsv(parts), 'utf8');
  const kind = FORMAT_FILES[input.format];
  const file = await deps.services.call(createExport, {
    body: {
      name: `${input.name}.${kind.extension}`, contentType: kind.contentType as never, content: bytes.toString('base64'), source: input.source,
      runReference: result.queryId, ...(input.folderId === undefined ? {} : { folderId: input.folderId }), inputs,
      printedMarkingIds: markings.map((m) => m.id),
      fieldPolicies: result.columns.map((c) => ({ property: c.property, apiName: c.apiName, effect: c.effect })),
      connectionIds: [...new Set(result.lineage.flatMap((l) => l.sources.map((s) => s.connectionId)))],
    },
  }, { ...options, idempotencyKey: `render.${ctx.idempotencyKey ?? result.queryId}`, timeoutMs: 60_000 });
  return { outcome: 'exported', file, rows: rows.length };
}

/** A keyed retry: the file the first request made, as its maker sees it. */
export async function rendered(deps: RenderDeps, ctx: Context, ref: string | undefined): Promise<Output> {
  if (ref === undefined || ref === '') throw new AppError('conflict', 'the first request made no file', { code: 'render.nothing_made' });
  const [fileId, rows] = ref.split('.');
  const file: FileView = await deps.services.call(getExport, { params: { fileId: fileId! } }, { request: ctx.request, correlationId: ctx.correlationId });
  return { outcome: 'exported', file, rows: Number(rows ?? 0) };
}
