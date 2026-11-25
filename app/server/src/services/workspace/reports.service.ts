// Reports (D233): a person's document of headings, text and live blocks. The owner edits it;
// others open it through shares, under the owner's sharing policy as ceiling (37.4). Each live
// block is read for whoever opens the report, as them: an object set's objects (a set they may not
// read refused with why, a property they may not see left blank), or a workbook's computed cells
// (a workbook that does not reach them refused). Nothing read is stored. An export reads every
// block as the exporter and files a PDF of it in Files, carrying the markings of what it read.

import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { reportDocument, type ReportDocument, type ReportView } from '../../contracts/workspace/report.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Report } from '../../models/workspace/report.model.ts';
import { reportRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { PDF_CONTENT_TYPE, renderReportPdf, type ReportBlock } from '../render/pdf.service.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentHeld, type DocumentKind, type SharedDocument } from './documentShares.service.ts';
import { parseCell } from './formula.service.ts';
import { opens, readRange, typesOf, workbookFigures } from './workbooks.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
const notFound = () => new AppError('not_found', 'no such report', { code: 'workspace.report_not_found' });
const stale = () => new AppError('conflict', 'the report changed since you read it', { code: 'workspace.report_stale' });
const refuse = (message: string, code: string) => new AppError('validation', message, { code });

export const blankReport = (name: string): ReportDocument => ({ schemaVersion: '1', blocks: [{ id: 'title', kind: 'heading', text: name.slice(0, 200), level: 1 }] });
const documentOf = (r: Report): ReportDocument => reportDocument.parse(r.document);

const summaryOf = (r: Report, held: DocumentHeld) => ({
  id: r.id, name: r.name, ownerMembershipId: r.ownerMembershipId, visibility: r.visibility, access: held,
  createdAt: r.createdAt, updatedAt: r.updatedAt, archivedAt: r.archivedAt, lockVersion: r.lockVersion,
});
const viewOf = (r: Report, held: DocumentHeld): ReportView => ({ ...summaryOf(r, held), document: documentOf(r) });

export const REPORT: DocumentKind<Report> = {
  arm: 'report', notFound,
  findForUpdate: (db, id) => reportRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => reportRepo.update(db, id, { visibility }),
};
const kind = REPORT as DocumentKind<SharedDocument>;
const heldBy = (db: Queryable, r: Report, membershipId: string) => heldOn(db, kind, r, membershipId);

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ r: Report; held: DocumentHeld }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const r = await reportRepo.findById(db, id);
    const held = r === undefined ? undefined : await heldBy(db, r, me.membershipId);
    return r === undefined || held === undefined ? undefined : { r, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

/** Live blocks as the owner saves them: over sets and properties the owner may see, and workbooks, sheets and ranges they may open. */
async function checkBlocks(deps: WorkspaceDeps, ctx: Context, me: Member, doc: ReportDocument): Promise<void> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const objects = doc.blocks.filter((b) => b.kind === 'objects');
  if (objects.length > 0) {
    const manifest = await deps.services.call(getManifest, { query: {} }, options);
    for (const objectSetId of new Set(objects.map((b) => b.objectSetId))) {
      let set: { baseTypeId: string | null };
      try {
        set = await deps.services.call(getObjectSet, { params: { objectSetId } }, options);
      } catch (error) {
        if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) throw refuse('a block reads an object set you may not see', 'workspace.report_set_unknown');
        throw error;
      }
      const known = new Set(manifest.objectTypes.find((t) => t.id === set.baseTypeId)?.properties.map((p) => p.identityId) ?? []);
      if (objects.some((b) => b.objectSetId === objectSetId && b.propertyIds.some((p) => !known.has(p)))) {
        throw refuse('a block names a property its set\'s type does not have', 'workspace.report_property_unknown');
      }
    }
  }
  for (const b of doc.blocks) {
    if (b.kind !== 'workbook') continue;
    const wb = await opens(deps, me, b.workbookId);
    if (wb === undefined) throw refuse('a block embeds a workbook you may not open', 'workspace.report_workbook_unknown');
    if (!wb.sheets.some((s) => s.id === b.sheetId)) throw refuse('a block names a sheet the workbook does not have', 'workspace.report_sheet_unknown');
    const [from, to] = b.range.split(':').map((c) => parseCell(c));
    if (from === undefined || to === undefined) throw refuse('a block names a range off the sheet', 'workspace.report_range_invalid');
    if (Math.abs(to.col - from.col) + 1 > 12 || Math.abs(to.row - from.row) + 1 > 501) throw refuse('a workbook block shows at most 12 columns and 500 rows', 'workspace.report_range_too_large');
  }
}

export async function create(deps: WorkspaceDeps, ctx: Context, name: string): Promise<ReportView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'report.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const r = await reportRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: blankReport(name) as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'report_created', resource: { type: 'report', id: r.id }, detail: { copied_from: null } });
    return viewOf(r, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { reports: (await reportRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((r) => summaryOf(r, 'owner')) };
    const out: ReturnType<typeof summaryOf>[] = [];
    for (const r of await reportRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'report', me.membershipId), limit)) {
      const held = await heldBy(db, r, me.membershipId);
      if (held !== undefined && held !== 'owner') out.push(summaryOf(r, held));
    }
    return { reports: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string): Promise<ReportView> {
  const me = member(ctx);
  const { r, held } = await readable(deps, me, id);
  return viewOf(r, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { name?: string | undefined; document: ReportDocument; lockVersion: number }): Promise<ReportView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'report.save' });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => reportRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await checkBlocks(deps, ctx, me, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const r = await reportRepo.findForUpdate(db, id);
    if (!r || r.ownerMembershipId !== me.membershipId) throw notFound();
    if (r.archivedAt !== null) throw new AppError('conflict', 'an archived report is not edited', { code: 'workspace.report_archived' });
    if (r.lockVersion !== input.lockVersion) throw stale();
    const saved = (await reportRepo.update(db, id, { ...(input.name === undefined ? {} : { name: input.name }), document: input.document as never, lockVersion: r.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'report_saved', resource: { type: 'report', id },
      detail: { blocks: input.document.blocks.length, live_blocks: input.document.blocks.filter((b) => b.kind === 'objects' || b.kind === 'workbook').length },
    });
    return viewOf(saved, 'owner');
  });
}

interface BlockRead {
  id: string; header: string[]; rows: unknown[][]; total: number | null; truncated: boolean; withheld: number; refused: string | null;
  lineage: { node: NodeRef; relation: Relation }[];
}

/** Every live block read as the caller. */
async function readBlocks(deps: WorkspaceDeps, ctx: Context, doc: ReportDocument): Promise<BlockRead[]> {
  const types = await typesOf(deps, ctx, doc.blocks.flatMap((b) => (b.kind === 'objects' ? [b.objectSetId] : [])));
  return Promise.all(doc.blocks.flatMap((b): Promise<BlockRead>[] => {
    if (b.kind === 'objects') {
      return [readRange(deps, ctx, { id: b.id, objectSetId: b.objectSetId, propertyIds: b.propertyIds, limit: b.limit }, types.get(b.objectSetId))
        .then((r) => ({ id: b.id, header: r.header, rows: r.rows, total: r.refused === null ? r.total : null, truncated: r.truncated, withheld: r.withheld, refused: r.refused, lineage: r.lineage }))];
    }
    if (b.kind === 'workbook') {
      return [workbookFigures(deps, ctx, b.workbookId, b.sheetId, b.range, b.header)
        .then((f) => ({ id: b.id, header: f.header, rows: f.rows, total: null, truncated: false, withheld: 0, refused: f.refused, lineage: f.lineage }))];
    }
    return [];
  }));
}

export async function blocks(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const { r } = await readable(deps, me, id);
  const read = await readBlocks(deps, ctx, documentOf(r));
  return {
    computedAt: new Date().toISOString(),
    blocks: read.map(({ lineage: _l, ...rest }) => ({ ...rest, rows: rest.rows as import('zod').z.core.util.JSONType[][] })),
  };
}

export async function copy(deps: WorkspaceDeps, ctx: Context, id: string, name: string): Promise<ReportView> {
  const me = member(ctx);
  const { r, held } = await readable(deps, me, id);
  if (held === 'view') throw new AppError('forbidden', 'this report is shared with you to open, not to copy', { code: 'workspace.report_copy_not_shared' });
  await demand(deps, ctx, { permission: 'report.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const made = await reportRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: r.document as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'report_created', resource: { type: 'report', id: made.id }, detail: { copied_from: r.id } });
    return viewOf(made, 'owner');
  });
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string): Promise<ReportView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const r = await reportRepo.findForUpdate(db, id);
    if (!r || r.ownerMembershipId !== me.membershipId) throw notFound();
    const done = r.archivedAt !== null ? r : (await reportRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: r.lockVersion + 1 }))!;
    if (r.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'report_archived', resource: { type: 'report', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

const asShare = <T extends { documentId: string }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, reportId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'report.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => asShare(await shareDocument(db, me, ctx.correlationId, kind, id, input)));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => asShare(await revokeDocumentShare(db, me, ctx.correlationId, kind, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, kind, await reportRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function exportReport(deps: WorkspaceDeps, ctx: Keyed, id: string, folderId: string | undefined): Promise<{ file: FileView }> {
  const me = member(ctx);
  const { r } = await readable(deps, me, id);
  const doc = documentOf(r);
  const read = await readBlocks(deps, ctx, doc);
  const inputs = [
    { node: { kind: 'report' as const, refId: r.id, version: String(r.lockVersion) }, relation: 'exported_from' as const },
    ...new Map(read.flatMap((b) => b.lineage).map((l) => [`${l.node.kind}${l.node.refId}${l.node.version}`, l])).values(),
  ];
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);
  const computedAt = new Date().toISOString();
  const pdfBlocks: ReportBlock[] = doc.blocks.map((b): ReportBlock => {
    if (b.kind === 'heading') return { kind: 'heading', text: b.text, level: b.level };
    if (b.kind === 'text') return { kind: 'text', text: b.text };
    const got = read.find((x) => x.id === b.id)!;
    const note = got.refused !== null ? `Not shown to you: ${got.refused}.`
      : [got.truncated && got.total !== null ? `The first ${got.rows.length} of ${got.total} objects.` : '', got.withheld > 0 ? `${got.withheld} column${got.withheld === 1 ? '' : 's'} withheld from you.` : ''].filter(Boolean).join(' ') || undefined;
    return { kind: 'table', caption: b.caption, header: got.header, rows: got.rows.map((row) => row.map(cellText)), note };
  });
  const bytes = renderReportPdf({ name: r.name, markings: markings.map((m) => m.name), computedAt, blocks: pdfBlocks });
  const file = await deps.services.call(createExport, {
    body: {
      name: `${r.name.slice(0, 190)}.pdf`, contentType: PDF_CONTENT_TYPE as 'application/pdf', content: bytes.toString('base64'), source: { kind: 'report', reportId: r.id },
      ...(folderId === undefined ? {} : { folderId }), inputs, printedMarkingIds: markings.map((m) => m.id), fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `report.${ctx.idempotencyKey ?? r.id}` });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'report_exported', resource: { type: 'report', id: r.id }, detail: { file_id: file.id, blocks: doc.blocks.length, markings: markings.length },
  }));
  return { file };
}
