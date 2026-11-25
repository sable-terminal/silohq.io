// Reports (D233; beyond the spec: the report tool of the Foundry-comparison features). A report
// is a person's document: headings and text they wrote, and live blocks read for whoever opens it,
// as them: an object set's objects with chosen properties, or a rectangle of a workbook's computed
// cells (its figures: totals, ratios, lookups). Nothing read is stored. Shared like a workbook, to
// open or to copy; only the owner edits. Exported into Files as a PDF of what the exporter sees,
// carrying the markings of what its blocks read.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { fileView } from '../files/file.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;
const slug = z.string().regex(/^[a-z0-9-]{1,40}$/);
const caption = z.string().trim().max(200).optional();

export const reportBlock = z.discriminatedUnion('kind', [
  z.strictObject({ id: slug, kind: z.literal('heading'), text: z.string().trim().min(1).max(200), level: z.union([z.literal(1), z.literal(2)]).default(1) }),
  z.strictObject({ id: slug, kind: z.literal('text'), text: z.string().max(10_000) }),
  /** An object set's objects, a column per property: read for whoever opens the report. */
  z.strictObject({
    id: slug, kind: z.literal('objects'), caption, objectSetId: z.uuid(), propertyIds: z.array(z.uuid()).min(1).max(12), limit: z.int().min(1).max(500).default(50),
  }),
  /** A rectangle of a workbook's computed cells, the first row as the header where asked: what the opener's workbook computes. */
  z.strictObject({
    id: slug, kind: z.literal('workbook'), caption, workbookId: z.uuid(), sheetId: slug,
    range: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,4}:[A-Z]{1,3}[1-9][0-9]{0,4}$/), header: z.boolean().default(true),
  }),
]);
export type ReportBlockInput = z.infer<typeof reportBlock>;

export const reportDocument = z.strictObject({ schemaVersion: z.literal('1'), blocks: z.array(reportBlock).max(100) });
export type ReportDocument = z.infer<typeof reportDocument>;

const access = z.enum(['owner', 'view', 'copy']);
export const reportSummary = z.object({
  id: z.uuid(), name: z.string(), ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export const reportView = reportSummary.extend({ document: recordValue(reportDocument) });
export type ReportView = z.infer<typeof reportView>;

export const reportShareView = z.object({
  id: z.uuid(), reportId: z.uuid(), grantee: shareGrantee, access: z.enum(['view', 'copy']), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ reportId: z.uuid() });

export const createReport = defineContract({
  service: 'workspace', name: 'createReport', method: 'POST', path: '/v1/reports', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: z.strictObject({ name: z.string().trim().min(1).max(200) }), response: reportView, status: 201,
});

export const listReports = defineContract({
  service: 'workspace', name: 'listReports', method: 'GET', path: '/v1/reports', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ reports: z.array(reportSummary) }),
});

export const getReport = defineContract({
  service: 'workspace', name: 'getReport', method: 'GET', path: '/v1/reports/:reportId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: reportView,
});

/** The owner's edit: each object block over a set and properties the owner may see; each workbook block over one the owner may open. */
export const saveReport = defineContract({
  service: 'workspace', name: 'saveReport', method: 'PUT', path: '/v1/reports/:reportId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ name: z.string().trim().min(1).max(200).optional(), document: recordValue(reportDocument), lockVersion: z.int().min(1) }),
  response: reportView, maxBodyBytes: 2 * 1024 * 1024,
});

/** Each live block read now as the opener. */
export const readReportBlocks = defineContract({
  service: 'workspace', name: 'readReportBlocks', method: 'GET', path: '/v1/reports/:reportId/blocks', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  response: z.object({
    computedAt: z.string(),
    blocks: z.array(z.object({
      id: z.string(),
      header: z.array(z.string()),
      rows: recordValue(z.array(z.array(z.json()))),
      total: z.int().nullable(),
      truncated: z.boolean(),
      withheld: z.int(),
      refused: z.string().nullable(),
    })),
  }),
});

export const copyReport = defineContract({
  service: 'workspace', name: 'copyReport', method: 'POST', path: '/v1/reports/:reportId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ name: z.string().trim().min(1).max(200) }), response: reportView, status: 201,
});

export const archiveReport = defineContract({
  service: 'workspace', name: 'archiveReport', method: 'POST', path: '/v1/reports/:reportId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: reportView,
});

export const shareReport = defineContract({
  service: 'workspace', name: 'shareReport', method: 'POST', path: '/v1/reports/:reportId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(['view', 'copy']), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: reportShareView, status: 201,
});

export const revokeReportShare = defineContract({
  service: 'workspace', name: 'revokeReportShare', method: 'POST', path: '/v1/reports/:reportId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ reportId: z.uuid(), shareId: z.uuid() }), response: reportShareView,
});

export const listReportShares = defineContract({
  service: 'workspace', name: 'listReportShares', method: 'GET', path: '/v1/reports/:reportId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(reportShareView) }),
});

/** Into Files as a PDF of what the exporter sees now, with the markings of what its blocks read. */
export const exportReport = defineContract({
  service: 'workspace', name: 'exportReport', method: 'POST', path: '/v1/reports/:reportId/exports', callers: CALLERS,
  shed: 'export_render', context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ folderId: z.uuid().optional() }),
  response: z.object({ file: fileView }), status: 201,
});
