// Exporting a lineage graph (spec 59.4, 59.7): the reviewer's query, as a document in Files.
//
// 1. lineage.read, organisation-wide, as for every reviewer query.
// 2. The same bounded walk as the query, withholding what the reviewer's markings do not
//    reach: counted in the document, never named. A graph larger than the bounds is refused
//    with the bound named, never truncated (invariant 2).
// 3. Every node the document names is one of its lineage inputs (exported_from), so it
//    carries their markings (spec 58.6). Files says which those are, to print.
// 4. The document (JSON, or CSV a spreadsheet opens), then Files stores it with its lineage,
//    provenance (the node walked from) and frozen permissions, or refuses if a marking changed
//    in between. lineage_exported names the file.

import type { z } from 'zod';
import { createExport, getExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import { LINEAGE_EXPORT_FILES, type exportLineage, type LineageExportFormat } from '../../contracts/lineage/export.contract.ts';
import type { GraphView, NodeKind } from '../../contracts/lineage/lineage.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { cell } from '../render/csv.service.ts';
import { counts, demand, recordEvent, walk, type LineageDeps } from './read.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller' | 'idempotencyKey'>;
type Input = z.output<typeof exportLineage.body>;
type Output = z.output<typeof exportLineage.response>;

export interface LineageDocumentInput {
  name: string;
  /** The markings the document carries, by id, with the names printed. */
  markings: readonly { id: string; name: string }[];
  exportedAt: string;
  query: { kind: NodeKind; refId: string; version: string | undefined; depth: number; maxNodes: number };
  graph: GraphView;
}

const withheldStatement = (n: number): string | null =>
  n === 0 ? null : `${n} node${n === 1 ? '' : 's'} outside the exporter's markings ${n === 1 ? 'was' : 'were'} withheld: counted, never named`;

const markingNames = (input: LineageDocumentInput) => {
  const byId = new Map(input.markings.map((m) => [m.id, m.name]));
  return (ids: readonly string[]): string[] => ids.map((id) => byId.get(id) ?? id);
};

/** The graph as one JSON document. Pure. */
export function lineageJson(input: LineageDocumentInput): string {
  const names = markingNames(input);
  const { graph, query } = input;
  return `${JSON.stringify({
    name: input.name,
    markings: input.markings.map((m) => m.name),
    exportedAt: input.exportedAt,
    query: { direction: graph.direction, kind: query.kind, refId: query.refId, version: query.version ?? null, depth: query.depth, maxNodes: query.maxNodes },
    root: graph.root,
    withheld: graph.withheld,
    statement: withheldStatement(graph.withheld),
    nodes: graph.nodes.map((n) => ({
      id: n.id, kind: n.kind, refId: n.refId, version: n.version, depth: n.depth, createdAt: n.createdAt, markings: names(n.markingIds),
    })),
    edges: graph.edges,
  }, null, 2)}\n`;
}

const CSV_HEADER = ['record', 'id', 'kind', 'ref_id', 'version', 'depth', 'created_at', 'markings', 'from', 'to', 'relation'];
const line = (cells: readonly unknown[]): string => `${cells.map(cell).join(',')}\r\n`;

/**
 * The graph as CSV: what travels with it first (its name, markings, the query and what was
 * withheld), then one row per node and one per edge, in one table a spreadsheet opens. Pure.
 */
export function lineageCsv(input: LineageDocumentInput): string {
  const names = markingNames(input);
  const { graph, query } = input;
  const head: [string, string][] = [
    ['Name', input.name],
    ['Markings', input.markings.length === 0 ? 'none' : input.markings.map((m) => m.name).join('; ')],
    ['Exported at', input.exportedAt],
    ['Query', `${graph.direction} of ${query.kind} ${query.refId}${query.version === undefined ? '' : ` version ${query.version}`}`],
    ['Bounds', `depth ${query.depth}, ${query.maxNodes} nodes`],
    ['Withheld', withheldStatement(graph.withheld) ?? 'none'],
  ];
  let out = head.map((pair) => line(pair)).join('');
  out += '\r\n';
  out += line(CSV_HEADER);
  for (const n of graph.nodes) out += line(['node', n.id, n.kind, n.refId, n.version, n.depth, n.createdAt, names(n.markingIds).join('; '), '', '', '']);
  for (const e of graph.edges) out += line(['edge', '', '', '', '', '', '', '', e.from, e.to, e.relation]);
  return out;
}

const DOCUMENTS: Readonly<Record<LineageExportFormat, (input: LineageDocumentInput) => string>> = { json: lineageJson, csv: lineageCsv };

/** lineage.read: the walk, as a document in Files (spec 59.4, 59.7). */
export async function exportGraph(deps: LineageDeps, ctx: Context, input: Input): Promise<Output> {
  await demand(deps, ctx, 'lineage.read');
  const query = { kind: input.kind, refId: input.refId, version: input.version, depth: input.depth, maxNodes: input.maxNodes };
  const { graph } = await walk(deps, ctx, query, input.direction, input.direction === 'downstream');
  const inputs = graph.nodes.map((n) => ({ node: { kind: n.kind, refId: n.refId, version: n.version }, relation: 'exported_from' as const }));
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);

  const name = input.name ?? `Lineage ${input.direction} of ${input.kind} ${input.refId}`;
  const file = LINEAGE_EXPORT_FILES[input.format];
  const content = DOCUMENTS[input.format]({ name, markings, exportedAt: new Date().toISOString(), query, graph });
  const stored = await deps.services.call(createExport, {
    body: {
      name: `${name}.${file.extension}`, contentType: file.contentType, content: Buffer.from(content, 'utf8').toString('base64'),
      source: { kind: 'lineage', lineageNodeId: graph.root }, ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      inputs, printedMarkingIds: markings.map((m) => m.id), fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `lineage.${ctx.idempotencyKey ?? uuidv7()}`, timeoutMs: 60_000 });
  await recordEvent(deps, ctx, 'lineage_exported', { type: input.kind, id: input.refId }, {
    file_id: stored.id, query: input.direction, format: input.format, markings: markings.length, ...counts(graph, input.depth),
  });
  return { file: stored, nodes: graph.nodes.length, edges: graph.edges.length, withheld: graph.withheld };
}

/** The reference a keyed retry replays: the file, and the counts the first request returned. */
export const exportRef = (out: Output): string => [out.file.id, out.nodes, out.edges, out.withheld].join('.');

/** A keyed retry: the file the first request made, as its maker sees it. */
export async function exported(deps: LineageDeps, ctx: Context, ref: string | undefined): Promise<Output> {
  const [fileId, nodes, edges, withheld] = (ref ?? '').split('.');
  if (fileId === undefined || fileId === '') throw new AppError('conflict', 'the first request made no file', { code: 'lineage.nothing_exported' });
  const file: FileView = await deps.services.call(getExport, { params: { fileId } }, { request: ctx.request, correlationId: ctx.correlationId });
  return { file, nodes: Number(nodes ?? 0), edges: Number(edges ?? 0), withheld: Number(withheld ?? 0) };
}
