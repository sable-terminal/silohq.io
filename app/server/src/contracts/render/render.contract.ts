// render (the catalogue: server-side export rendering; spec 41.2): turns a compiled plan's
// result into a document placed in Files, under the caller's own access at that moment.
//
// The result is the executor's, re-run for the caller (a fresh result from the data plane
// when the same plan ran for the same permissions within its life, so a Cron's report is the
// answer its run saw). Redaction is to what the caller may see, not to what the plan asks
// for: a redacted property is stated as omitted, never left as a gap; masked values stay
// masked; a disputed value is printed as disputed. Flags survive (invariant 10): the
// coverage of the answer and its undecided values are printed with it, and so are its
// markings (invariant 7), at the head of the document.
//
// Formats: CSV, a spreadsheet (.xlsx) and a PDF, each printing the same head and table
// (services/render/document.service.ts). The workbook and the PDF are written by Silo's own
// code, with no library and nothing fetched or parsed (standard PDF fonts, no embedding), so
// rendering needs no sandbox beyond the service's own: it reads nothing but the answer.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { exportSource, fileView } from '../files/file.contract.ts';

export const RENDER_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** Each format's file extension and media type. */
export const FORMAT_FILES: Readonly<Record<RenderFormat, { extension: string; contentType: string }>> = {
  csv: { extension: 'csv', contentType: 'text/csv' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
};

export const renderExport = defineContract({
  service: 'render', name: 'renderExport', method: 'POST', path: '/v1/exports', callers: ['gateway', 'scheduler'],
  // A retry under the same key returns the file it made, never a second one.
  shed: 'export_render', context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    /** The compiled plan whose result is exported (ontology.compiled_manifests). */
    planId: z.uuid(),
    format: z.enum(RENDER_FORMATS).default('csv'),
    name: z.string().trim().min(1).max(200),
    source: exportSource,
    folderId: z.uuid().optional(),
  }),
  response: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('exported'), file: fileView, rows: z.int() }),
    /** The plan could not run for the caller now (a bound, a source, the ontology): nothing was stored. */
    z.object({ outcome: z.literal('refused'), code: z.string(), reason: z.string() }),
  ]),
  status: 201, maxBodyBytes: 4096,
});
