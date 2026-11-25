// Workbooks (D232; beyond the spec: the spreadsheet of the Foundry-comparison features). A
// workbook is a person's spreadsheet: sheets of cells as they typed them (values, and formulas
// beginning with "=", in the closed language of services/workspace/formula.service.ts), and up
// to ten live ranges, each an object set the person may see read with chosen properties and
// placed at an anchor cell for whoever opens the workbook, under the opener's own access, never
// stored. Formulas read live cells like typed ones. Shared like a saved view (37.4: the owner's
// policy as ceiling): to open with live data (view) or to copy (copy); only the owner edits.
// Exported into Files as a spreadsheet of computed values, carrying the markings of what its
// live ranges read.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { fileView } from '../files/file.contract.ts';
import { shareGrantee } from './sharing.contract.ts';

const CALLERS = ['gateway'] as const;
const slug = z.string().regex(/^[a-z0-9-]{1,40}$/);
export const cellRef = z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,4}$/);
const cellInput = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const workbookSheet = z.strictObject({
  id: slug,
  /** A sheet name formulas can name: no characters a reference uses. */
  name: z.string().trim().min(1).max(60).regex(/^[^!'[\]*?/\\:]+$/),
  cells: z.record(cellRef, cellInput),
});

export const liveRange = z.strictObject({
  id: slug,
  sheetId: slug,
  /** The top-left cell: a header row of property names, then one row per object. */
  anchor: cellRef,
  objectSetId: z.uuid(),
  propertyIds: z.array(z.uuid()).min(1).max(30),
  limit: z.int().min(1).max(1_000).default(200),
});
export type LiveRange = z.infer<typeof liveRange>;

export const MAX_CELLS = 50_000;
export const workbookDocument = z.strictObject({
  schemaVersion: z.literal('1'),
  sheets: z.array(workbookSheet).min(1).max(20),
  liveRanges: z.array(liveRange).max(10).default([]),
}).refine((d) => d.sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0) <= MAX_CELLS, `a workbook holds at most ${MAX_CELLS} cells`);
export type WorkbookDocument = z.infer<typeof workbookDocument>;

const access = z.enum(['owner', 'view', 'copy']);
export const workbookSummary = z.object({
  id: z.uuid(), name: z.string(), ownerMembershipId: z.uuid(), visibility: z.enum(['private', 'shared', 'org_visible']), access,
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export const workbookView = workbookSummary.extend({ document: recordValue(workbookDocument) });
export type WorkbookView = z.infer<typeof workbookView>;

export const workbookShareView = z.object({
  id: z.uuid(), workbookId: z.uuid(), grantee: shareGrantee, access: z.enum(['view', 'copy']), sharedBy: z.uuid(), sharedAt: z.string(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), state: z.enum(['live', 'expired', 'revoked', 'suspended', 'forbidden_by_policy']),
});

const params = z.strictObject({ workbookId: z.uuid() });

export const createWorkbook = defineContract({
  service: 'workspace', name: 'createWorkbook', method: 'POST', path: '/v1/workbooks', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', body: z.strictObject({ name: z.string().trim().min(1).max(200) }), response: workbookView, status: 201,
});

export const listWorkbooks = defineContract({
  service: 'workspace', name: 'listWorkbooks', method: 'GET', path: '/v1/workbooks', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ workbooks: z.array(workbookSummary) }),
});

export const getWorkbook = defineContract({
  service: 'workspace', name: 'getWorkbook', method: 'GET', path: '/v1/workbooks/:workbookId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: workbookView,
});

/** The owner's edit: every live range checked against what the owner may see and the cells it would cover. */
export const saveWorkbook = defineContract({
  service: 'workspace', name: 'saveWorkbook', method: 'PUT', path: '/v1/workbooks/:workbookId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ name: z.string().trim().min(1).max(200).optional(), document: recordValue(workbookDocument), lockVersion: z.int().min(1) }),
  response: workbookView, maxBodyBytes: 4 * 1024 * 1024,
});

/** Each live range read now as the opener: a header, rows, and why one was not read. */
export const readWorkbookRanges = defineContract({
  service: 'workspace', name: 'readWorkbookRanges', method: 'GET', path: '/v1/workbooks/:workbookId/ranges', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  response: z.object({
    ranges: z.array(z.object({
      id: z.string(),
      header: z.array(z.string()),
      rows: recordValue(z.array(z.array(z.json()))),
      /** Objects in the set, of which the first `limit` are placed. */
      total: z.int(),
      truncated: z.boolean(),
      computedAt: z.string().nullable(),
      /** Properties the opener may not see: their cells are left blank. */
      withheld: z.int(),
      refused: z.string().nullable(),
    })),
  }),
});

export const copyWorkbook = defineContract({
  service: 'workspace', name: 'copyWorkbook', method: 'POST', path: '/v1/workbooks/:workbookId/copies', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ name: z.string().trim().min(1).max(200) }), response: workbookView, status: 201,
});

export const archiveWorkbook = defineContract({
  service: 'workspace', name: 'archiveWorkbook', method: 'POST', path: '/v1/workbooks/:workbookId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: workbookView,
});

export const shareWorkbook = defineContract({
  service: 'workspace', name: 'shareWorkbook', method: 'POST', path: '/v1/workbooks/:workbookId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee: shareGrantee, access: z.enum(['view', 'copy']), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: workbookShareView, status: 201,
});

export const revokeWorkbookShare = defineContract({
  service: 'workspace', name: 'revokeWorkbookShare', method: 'POST', path: '/v1/workbooks/:workbookId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ workbookId: z.uuid(), shareId: z.uuid() }), response: workbookShareView,
});

export const listWorkbookShares = defineContract({
  service: 'workspace', name: 'listWorkbookShares', method: 'GET', path: '/v1/workbooks/:workbookId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(workbookShareView) }),
});

/** Into Files: every sheet's values as computed now for the exporter, with the markings of what the live ranges read. */
export const exportWorkbook = defineContract({
  service: 'workspace', name: 'exportWorkbook', method: 'POST', path: '/v1/workbooks/:workbookId/exports', callers: CALLERS,
  shed: 'export_render', context: 'organisation', idempotency: 'keyed', params, body: z.strictObject({ folderId: z.uuid().optional() }),
  response: z.object({ file: fileView }), status: 201,
});
