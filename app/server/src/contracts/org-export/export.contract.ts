// The organisation export (spec 2.6): exit as a product capability. Connectors, the
// ontology, Functions, applications and Crons are validated data documents, so they export
// whole and read without Silo.
//
//   Connector manifests         every version, validated YAML, with its JSON Schema; never a credential
//   Ontology                    every object type, property mapping, link type, interface, action type
//                               and function version, JSON with a published schema
//   Resolution                  confirmed exact mappings and field authorities, CSV and JSON; match keys only
//   Applications, views, Crons, their validated definitions, JSON
//   scenarios
//   Receipts and audit          every receipt and audit row, JSON Lines, lineage references resolved
//   Siloes                      captured transitions, imported files with their extractions, and index
//                               contents, in their original formats plus Parquet
//
// Binding rule: a super admin (org.export) can run a full export at any time, including in
// suspended and cancelled billing states within the retention window; export is never
// withheld. Exports respect markings: an artefact carrying a marking the requester is not
// cleared for is omitted and named as omitted.
//
// What the requester receives: the bundle (a gzipped tar of every file, the manifest and the
// schemas), the manifest (each file's path, SHA-256, size and rows, and each omission), and
// the receipt (counts, the manifest's and the bundle's hashes, the omissions, the billing
// status it ran under). Each is read in parts, as base64, through the gateway.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const ORG_EXPORT_EVENTS = ['org_export_requested', 'org_export_completed'] as const;
export const EXPORT_FAMILIES = [
  'connector_manifests', 'ontology', 'resolution', 'applications', 'views', 'crons', 'scenarios', 'receipts', 'audit',
  'siloes_transitions', 'siloes_imports', 'siloes_index',
] as const;
export type ExportFamily = (typeof EXPORT_FAMILIES)[number];
export const EXPORT_FORMATS = ['yaml', 'json', 'jsonl', 'csv', 'parquet', 'original'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** The published export schema's version (org_exports.format_version). */
export const EXPORT_FORMAT_VERSION = '2026-11-04';
/** The largest part read at once: as base64 in JSON, within a service response's 8 MiB. */
export const MAX_PART_BYTES = 4 * 1024 * 1024;

export const exportItemView = z.object({
  family: z.enum(EXPORT_FAMILIES),
  artefact: z.string(),
  format: z.enum(EXPORT_FORMATS),
  status: z.enum(['included', 'omitted_marking']),
  /** The marking that caused an omission. */
  omittedMarkingId: z.uuid().nullable(),
  path: z.string().nullable(),
  sha256: z.string().nullable(),
  bytes: z.string().nullable(),
  rows: z.string().nullable(),
});

export const orgExportView = z.object({
  id: z.uuid(),
  status: z.enum(['requested', 'running', 'completed', 'failed', 'cancelled']),
  requestedByMembershipId: z.uuid(),
  billingStatusAtRequest: z.enum(['active', 'past_due', 'suspended', 'cancelled']),
  formatVersion: z.string(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureCategory: z.string().nullable(),
  itemCount: z.int().nullable(),
  omittedItemCount: z.int().nullable(),
  bundleBytes: z.string().nullable(),
  bundleSha256: z.string().nullable(),
  manifestSha256: z.string().nullable(),
  receiptSha256: z.string().nullable(),
  receiptIssuedAt: z.string().nullable(),
});
export type OrgExportView = z.infer<typeof orgExportView>;

export const requestOrgExport = defineContract({
  service: 'org-export', name: 'requestOrgExport', method: 'POST', path: '/v1/org-exports', callers: ['gateway'],
  // One export at a time per organisation (org_exports_live): asking again while one runs is refused.
  shed: 'export_render', context: 'organisation', idempotency: 'none',
  response: orgExportView,
  status: 202,
});

export const listOrgExports = defineContract({
  service: 'org-export', name: 'listOrgExports', method: 'GET', path: '/v1/org-exports', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ exports: z.array(orgExportView) }),
});

export const getOrgExport = defineContract({
  service: 'org-export', name: 'getOrgExport', method: 'GET', path: '/v1/org-exports/:exportId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ exportId: z.uuid() }),
  response: orgExportView.extend({ items: z.array(exportItemView) }),
});

/** A part of the bundle, the manifest or the receipt, from offset for at most MAX_PART_BYTES. */
export const downloadOrgExport = defineContract({
  service: 'org-export', name: 'downloadOrgExport', method: 'GET', path: '/v1/org-exports/:exportId/content', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ exportId: z.uuid() }),
  query: z.strictObject({
    part: z.enum(['bundle', 'manifest', 'receipt']),
    offset: z.coerce.number().int().min(0).default(0),
    length: z.coerce.number().int().min(1).max(MAX_PART_BYTES).default(MAX_PART_BYTES),
  }),
  response: z.object({
    name: z.string(),
    contentType: z.string(),
    /** The whole part's size and SHA-256, to check the assembled file against. */
    totalBytes: z.int(),
    sha256: z.string(),
    offset: z.int(),
    content: z.base64(),
  }),
});
