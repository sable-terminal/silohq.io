// Exporting a lineage graph (spec 59.4, 59.7): a reviewer holding lineage.read takes the
// upstream or downstream of a resource out as a document in Files. It is the same walk as
// the reviewer's query, with the same bounds and the same withholding: a node the
// reviewer's markings do not reach is counted in the document, never named, and nothing
// reached only through it is shown.
//
// The document is an export like any other (spec 41.2): frozen at creation, made under the
// reviewer's permissions, carrying the markings of every node it names (its lineage inputs,
// spec 58.6), printed in it. Lineage nodes never hold record values, so neither does it.
//
// Kept apart from lineage.contract.ts because it names the files contract's view, and the
// files contract already reads lineage's node references.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { fileView } from '../files/file.contract.ts';
import { DEFAULT_DEPTH, MAX_DEPTH, NODE_KINDS } from './lineage.contract.ts';

export const LINEAGE_EXPORT_FORMATS = ['json', 'csv'] as const;
export type LineageExportFormat = (typeof LINEAGE_EXPORT_FORMATS)[number];

export const LINEAGE_EXPORT_FILES: Readonly<Record<LineageExportFormat, { extension: string; contentType: 'application/json' | 'text/csv' }>> = {
  json: { extension: 'json', contentType: 'application/json' },
  csv: { extension: 'csv', contentType: 'text/csv' },
};

/** Every node a document names is one of its lineage inputs, and the lineage writer takes at most 2,000. */
export const LINEAGE_EXPORT_MAX_NODES = 2_000;

const name = z.string().trim().min(1).max(180).refine((n) => !/[\u0000-\u001f/\\]/.test(n), 'a name has no control characters or slashes');

/** lineage.read: a reviewer's query over the graph, stored in Files as a document (spec 59.4, 59.7). */
export const exportLineage = defineContract({
  service: 'lineage', name: 'exportLineage', method: 'POST', path: '/v1/lineage/review/exports', callers: ['gateway', 'admin-portal'],
  shed: 'export_render', context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    kind: z.enum(NODE_KINDS),
    refId: z.uuid(),
    /** Upstream: the latest version when absent. Downstream: every version of the resource when absent. */
    version: z.string().trim().min(1).max(200).optional(),
    direction: z.enum(['upstream', 'downstream']),
    depth: z.int().min(1).max(MAX_DEPTH).default(DEFAULT_DEPTH),
    maxNodes: z.int().min(1).max(LINEAGE_EXPORT_MAX_NODES).default(LINEAGE_EXPORT_MAX_NODES),
    format: z.enum(LINEAGE_EXPORT_FORMATS).default('json'),
    /** The document's name, without its extension. */
    name: name.optional(),
    folderId: z.uuid().optional(),
  }),
  response: z.object({
    file: fileView,
    nodes: z.int().min(0),
    edges: z.int().min(0),
    /** Nodes reached that the reviewer's markings do not reach: counted in the document, never named. */
    withheld: z.int().min(0),
  }),
  status: 201,
});
