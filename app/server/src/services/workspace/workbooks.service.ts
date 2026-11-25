// Workbooks (D232): a person's spreadsheet over live object sets. The owner edits it; others
// open it through shares, under the owner's sharing policy as ceiling (37.4). A live range is
// read for whoever opens it, as them: an object set they may not read is refused with why, a
// property they may not see leaves its cells blank, and nothing read is ever stored. Saving
// checks each live range against what the owner may see, and that it covers no typed cell and
// no other range. An export computes every sheet for the exporter and files the values in Files
// as a spreadsheet, carrying the markings of what the live ranges read.

import { readResultPage, runObjectSet, type ResultObject } from '../../contracts/executor/result.contract.ts';
import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import {
  workbookDocument, type LiveRange, type WorkbookDocument, type WorkbookView,
} from '../../contracts/workspace/workbook.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Workbook } from '../../models/workspace/workbook.model.ts';
import { viewShareRepo, workbookRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { renderWorkbookXlsx } from '../render/xlsx.service.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { columnName, display, key, MAX_COLS, MAX_ROWS, parseCell, recalculate, type Value } from './formula.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentKind, type SharedDocument } from './documentShares.service.ts';

type Held = 'owner' | 'view' | 'copy';
type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
const notFound = () => new AppError('not_found', 'no such workbook', { code: 'workspace.workbook_not_found' });
const stale = () => new AppError('conflict', 'the workbook changed since you read it', { code: 'workspace.workbook_stale' });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const blankDocument = (): WorkbookDocument => ({ schemaVersion: '1', sheets: [{ id: 'sheet-1', name: 'Sheet1', cells: {} }], liveRanges: [] });
const documentOf = (w: Workbook): WorkbookDocument => workbookDocument.parse(w.document);

function summaryOf(w: Workbook, held: Held) {
  return {
    id: w.id, name: w.name, ownerMembershipId: w.ownerMembershipId, visibility: w.visibility, access: held,
    createdAt: w.createdAt, updatedAt: w.updatedAt, archivedAt: w.archivedAt, lockVersion: w.lockVersion,
  };
}
const viewOf = (w: Workbook, held: Held): WorkbookView => ({ ...summaryOf(w, held), document: documentOf(w) });

export const WORKBOOK: DocumentKind<Workbook> = {
  arm: 'workbook', notFound,
  findForUpdate: (db, id) => workbookRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => workbookRepo.update(db, id, { visibility }),
};
const accessTo = (db: Queryable, w: Workbook, membershipId: string) => heldOn(db, WORKBOOK as DocumentKind<SharedDocument>, w, membershipId);

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ w: Workbook; held: Held }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const w = await workbookRepo.findById(db, id);
    const held = w === undefined ? undefined : await accessTo(db, w, me.membershipId);
    return w === undefined || held === undefined ? undefined : { w, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

/** Each range's cells on its sheet: a header row and `limit` rows of its properties. */
function footprint(r: LiveRange): { col: number; row: number; cols: number; rows: number } | undefined {
  const at = parseCell(r.anchor);
  return at === undefined ? undefined : { ...at, cols: r.propertyIds.length, rows: r.limit + 1 };
}
const inside = (f: { col: number; row: number; cols: number; rows: number }, col: number, row: number) =>
  col >= f.col && col < f.col + f.cols && row >= f.row && row < f.row + f.rows;

/** Live ranges as the owner saves them: on a sheet, inside the grid, over no typed cell and no other range, over sets and properties the owner may see. */
async function checkRanges(deps: WorkspaceDeps, ctx: Context, doc: WorkbookDocument): Promise<void> {
  const refuse = (message: string, code: string) => new AppError('validation', message, { code });
  const placed: { sheetId: string; f: NonNullable<ReturnType<typeof footprint>> }[] = [];
  for (const r of doc.liveRanges) {
    const sheet = doc.sheets.find((s) => s.id === r.sheetId);
    const f = footprint(r);
    if (sheet === undefined || f === undefined) throw refuse('a live range is on a sheet the workbook does not have', 'workspace.range_sheet_unknown');
    if (f.col + f.cols > MAX_COLS || f.row + f.rows > MAX_ROWS) throw refuse('a live range runs off the sheet', 'workspace.range_outside');
    for (const [name, input] of Object.entries(sheet.cells)) {
      const at = parseCell(name);
      if (at !== undefined && input !== null && input !== '' && inside(f, at.col, at.row)) {
        throw refuse(`a live range would cover the typed cell ${name}`, 'workspace.range_covers_cells');
      }
    }
    for (const other of placed) {
      if (other.sheetId === r.sheetId && f.col < other.f.col + other.f.cols && other.f.col < f.col + f.cols && f.row < other.f.row + other.f.rows && other.f.row < f.row + f.rows) {
        throw refuse('two live ranges overlap', 'workspace.range_overlaps');
      }
    }
    placed.push({ sheetId: r.sheetId, f });
  }
  if (doc.liveRanges.length === 0) return;
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  for (const objectSetId of new Set(doc.liveRanges.map((r) => r.objectSetId))) {
    let set: { baseTypeId: string | null };
    try {
      set = await deps.services.call(getObjectSet, { params: { objectSetId } }, options);
    } catch (error) {
      if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) throw refuse('a live range reads an object set you may not see', 'workspace.range_set_unknown');
      throw error;
    }
    const typeId = set.baseTypeId;
    const type = manifest.objectTypes.find((t) => t.id === typeId);
    const known = new Set(type?.properties.map((p) => p.identityId) ?? []);
    for (const r of doc.liveRanges.filter((x) => x.objectSetId === objectSetId)) {
      if (r.propertyIds.some((p) => !known.has(p))) throw refuse('a live range names a property its set\'s type does not have', 'workspace.range_property_unknown');
    }
  }
}

export async function create(deps: WorkspaceDeps, ctx: Context, name: string): Promise<WorkbookView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'workbook.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const w = await workbookRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: blankDocument() as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'workbook_created', resource: { type: 'workbook', id: w.id }, detail: { copied_from: null } });
    return viewOf(w, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { workbooks: (await workbookRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((w) => summaryOf(w, 'owner')) };
    const out: ReturnType<typeof summaryOf>[] = [];
    for (const w of await workbookRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'workbook', me.membershipId), limit)) {
      const held = await accessTo(db, w, me.membershipId);
      if (held !== undefined && held !== 'owner') out.push(summaryOf(w, held));
    }
    return { workbooks: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string): Promise<WorkbookView> {
  const me = member(ctx);
  const { w, held } = await readable(deps, me, id);
  return viewOf(w, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { name?: string | undefined; document: WorkbookDocument; lockVersion: number }): Promise<WorkbookView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'workbook.save' });
  // Only its owner edits: anyone else is told it does not exist, before anything of the edit is read.
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => workbookRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await checkRanges(deps, ctx, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const w = await workbookRepo.findForUpdate(db, id);
    if (!w || w.ownerMembershipId !== me.membershipId) throw notFound();
    if (w.archivedAt !== null) throw new AppError('conflict', 'an archived workbook is not edited', { code: 'workspace.workbook_archived' });
    if (w.lockVersion !== input.lockVersion) throw stale();
    const saved = (await workbookRepo.update(db, id, { ...(input.name === undefined ? {} : { name: input.name }), document: input.document as never, lockVersion: w.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'workbook_saved', resource: { type: 'workbook', id },
      detail: { sheets: input.document.sheets.length, cells: input.document.sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0), live_ranges: input.document.liveRanges.length },
    });
    return viewOf(saved, 'owner');
  });
}

export interface RangeRead {
  id: string; header: string[]; rows: unknown[][]; total: number; truncated: boolean; computedAt: string | null; withheld: number; refused: string | null;
  /** Each row's object (Silo id), in order: for a model's predictions (D240). Never sent out with the rows. */
  ids: string[];
  lineage: { node: NodeRef; relation: Relation }[];
}

/** One live range read as the caller: up to its limit, a property they may not see left blank. */
export async function readRange(deps: WorkspaceDeps, ctx: Context, r: Pick<LiveRange, 'id' | 'objectSetId' | 'propertyIds' | 'limit'>, typeId?: string | null): Promise<RangeRead> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const out = await deps.services.call(runObjectSet, { body: { objectSetId: r.objectSetId, select: r.propertyIds, trigger: 'saved_view_run', useCache: true } }, options)
    .catch((error: unknown) => (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden') ? { outcome: 'refusal' as const, refusal: { code: error.code, reason: error.message } } : Promise.reject(error)));
  if (out.outcome === 'refusal') {
    return { id: r.id, header: [], rows: [], total: 0, truncated: false, computedAt: null, withheld: 0, refused: out.refusal.reason, lineage: [], ids: [] };
  }
  const result = out.result;
  const objects: ResultObject[] = [...result.page.objects];
  for (let page = 1; page < result.page.count && objects.length < r.limit; page++) {
    objects.push(...(await deps.services.call(readResultPage, { params: { queryId: result.queryId, page } }, options)).objects);
  }
  const columns = r.propertyIds.map((p) => result.columns.find((c) => c.property === p));
  const shown = (c: (typeof columns)[number]) => c !== undefined && c.effect === 'allow';
  const rows = objects.slice(0, r.limit).map((o) => columns.map((c) => (c === undefined || !shown(c) || o.masked.includes(c.apiName) || o.redacted.includes(c.apiName) ? null : o.values[c.apiName] ?? null)));
  const lineage = new Map<string, { node: NodeRef; relation: Relation }>();
  for (const column of result.lineage) {
    // The type's version it read (its markings), and each connection it read through.
    if (typeId != null) lineage.set(`t${column.objectTypeVersionId}`, { node: { kind: 'object_type_version', refId: typeId, version: column.objectTypeVersionId }, relation: 'exported_from' });
    for (const s of column.sources) lineage.set(`c${s.connectionId}${s.connectorVersion}`, { node: { kind: 'connection', refId: s.connectionId, version: s.connectorVersion }, relation: 'exported_from' });
  }
  return {
    id: r.id, header: columns.map((c) => c?.displayName ?? 'Withheld'), rows, total: result.total, truncated: result.total > r.limit,
    computedAt: result.computedAt, withheld: columns.filter((c) => !shown(c)).length, refused: null, lineage: [...lineage.values()],
    ids: objects.slice(0, r.limit).map((o) => o.id),
  };
}

export async function readRanges(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const { w } = await readable(deps, me, id);
  const ranges = await Promise.all(documentOf(w).liveRanges.map((r) => readRange(deps, ctx, r)));
  return { ranges: ranges.map(({ lineage: _l, ids: _i, ...rest }) => ({ ...rest, rows: rest.rows as import('zod').z.core.util.JSONType[][] })) };
}

export async function copy(deps: WorkspaceDeps, ctx: Context, id: string, name: string): Promise<WorkbookView> {
  const me = member(ctx);
  const { w, held } = await readable(deps, me, id);
  if (held === 'view') throw new AppError('forbidden', 'this workbook is shared with you to open, not to copy', { code: 'workspace.workbook_copy_not_shared' });
  await demand(deps, ctx, { permission: 'workbook.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const made = await workbookRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: w.document as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'workbook_created', resource: { type: 'workbook', id: made.id }, detail: { copied_from: w.id } });
    return viewOf(made, 'owner');
  });
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string): Promise<WorkbookView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const w = await workbookRepo.findForUpdate(db, id);
    if (!w || w.ownerMembershipId !== me.membershipId) throw notFound();
    const done = w.archivedAt !== null ? w : (await workbookRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: w.lockVersion + 1 }))!;
    if (w.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'workbook_archived', resource: { type: 'workbook', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

// ----------------------------------------------------------------------------- sharing (37.4, as saved views)

const asShare = <T extends { documentId: string }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, workbookId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'workbook.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await shareDocument(db, me, ctx.correlationId, WORKBOOK as DocumentKind<SharedDocument>, id, input)));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await revokeDocumentShare(db, me, ctx.correlationId, WORKBOOK as DocumentKind<SharedDocument>, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, WORKBOOK as DocumentKind<SharedDocument>, await workbookRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}

// ----------------------------------------------------------------------------- export

/** Every sheet's values as computed for the exporter: its live ranges read as them, its formulas evaluated over them. */
export function computedSheets(doc: WorkbookDocument, reads: readonly { id: string; header: string[]; rows: unknown[][] }[], today: string): { name: string; rows: Value[][] }[] {
  const overlay = new Map<string, Value>();
  for (const r of doc.liveRanges) {
    const read = reads.find((x) => x.id === r.id);
    const sheet = doc.sheets.find((s) => s.id === r.sheetId);
    const at = parseCell(r.anchor);
    if (read === undefined || sheet === undefined || at === undefined) continue;
    read.header.forEach((h, c) => overlay.set(key(sheet.name, at.col + c, at.row), h));
    read.rows.forEach((row, i) => row.forEach((v, c) => overlay.set(key(sheet.name, at.col + c, at.row + 1 + i),
      v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : JSON.stringify(v))));
  }
  const values = recalculate(doc.sheets.map((s) => ({ name: s.name, cells: s.cells })), today, overlay);
  return doc.sheets.map((s) => {
    let maxCol = -1;
    let maxRow = -1;
    const at = (k: string) => { const [, rest] = k.split('!'); const [c, r] = rest!.split(',').map(Number); return { c: c!, r: r! }; };
    const mine = [...values.keys(), ...overlay.keys()].filter((k) => k.startsWith(`${s.name}!`));
    for (const k of mine) { const { c, r } = at(k); maxCol = Math.max(maxCol, c); maxRow = Math.max(maxRow, r); }
    const rows: Value[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const row: Value[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const k = key(s.name, c, r);
        row.push(overlay.get(k) ?? values.get(k) ?? null);
      }
      rows.push(row);
    }
    return { name: s.name, rows };
  });
}

export async function exportWorkbook(deps: WorkspaceDeps, ctx: Keyed, id: string, folderId: string | undefined): Promise<{ file: FileView }> {
  const me = member(ctx);
  const { w } = await readable(deps, me, id);
  const doc = documentOf(w);
  // Each set's type, so the export carries the markings of the type versions its ranges read.
  const types = await typesOf(deps, ctx, doc.liveRanges.map((r) => r.objectSetId));
  const reads = await Promise.all(doc.liveRanges.map((r) => readRange(deps, ctx, r, types.get(r.objectSetId))));
  const sheets = computedSheets(doc, reads, new Date().toISOString().slice(0, 10));
  const inputs = [
    { node: { kind: 'workbook' as const, refId: w.id, version: String(w.lockVersion) }, relation: 'exported_from' as const },
    ...new Map(reads.flatMap((r) => r.lineage).map((l) => [`${l.node.kind}${l.node.refId}${l.node.version}`, l])).values(),
  ];
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);
  const refused = reads.filter((r) => r.refused !== null).length;
  const bytes = renderWorkbookXlsx(sheets.map((s) => ({ name: s.name, rows: s.rows.map((row) => row.map((v) => (v !== null && typeof v === 'object' ? v.error : v))) })),
    markings.map((m) => m.name), refused === 0 ? [] : [`${refused} live range${refused === 1 ? ' was' : 's were'} not read for you, so ${refused === 1 ? 'it is' : 'they are'} blank`]);
  const file = await deps.services.call(createExport, {
    body: {
      name: `${w.name.slice(0, 190)}.xlsx`, contentType: XLSX, content: bytes.toString('base64'), source: { kind: 'workbook', workbookId: w.id },
      ...(folderId === undefined ? {} : { folderId }), inputs, printedMarkingIds: markings.map((m) => m.id), fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `workbook.${ctx.idempotencyKey ?? w.id}` });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'workbook_exported', resource: { type: 'workbook', id: w.id }, detail: { file_id: file.id, sheets: sheets.length, live_ranges: reads.length, markings: markings.length },
  }));
  return { file };
}

/** Each set's type, for the type versions a read's lineage names. */
export async function typesOf(deps: WorkspaceDeps, ctx: Context, objectSetIds: Iterable<string>): Promise<Map<string, string | null>> {
  const types = new Map<string, string | null>();
  for (const objectSetId of new Set(objectSetIds)) {
    const set = await deps.services.call(getObjectSet, { params: { objectSetId } }, { request: ctx.request, correlationId: ctx.correlationId }).catch(() => undefined);
    types.set(objectSetId, set?.baseTypeId ?? null);
  }
  return types;
}

/**
 * A rectangle of a workbook's computed cells, for a report (D233): the workbook opened as the
 * caller (it must reach them), its live ranges read as them and its formulas evaluated, the cells
 * shown as a cell shows them; the first row as the header where asked.
 */
export async function workbookFigures(deps: WorkspaceDeps, ctx: Context, workbookId: string, sheetId: string, range: string, withHeader: boolean)
  : Promise<{ header: string[]; rows: string[][]; refused: string | null; lineage: { node: NodeRef; relation: Relation }[] }> {
  const me = member(ctx);
  const found = await readable(deps, me, workbookId).catch(() => undefined);
  if (found === undefined) return { header: [], rows: [], refused: 'the workbook is not shared with you', lineage: [] };
  const doc = documentOf(found.w);
  const index = doc.sheets.findIndex((s) => s.id === sheetId);
  const [from, to] = range.split(':').map((c) => parseCell(c));
  if (index < 0 || from === undefined || to === undefined) return { header: [], rows: [], refused: 'the workbook no longer has that sheet or range', lineage: [] };
  const types = await typesOf(deps, ctx, doc.liveRanges.map((r) => r.objectSetId));
  const reads = await Promise.all(doc.liveRanges.map((r) => readRange(deps, ctx, r, types.get(r.objectSetId))));
  const computed = computedSheets(doc, reads, new Date().toISOString().slice(0, 10))[index]!;
  const rows: string[][] = [];
  for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++) {
    const row: string[] = [];
    for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c++) row.push(display(computed.rows[r]?.[c] ?? null));
    rows.push(row);
  }
  const lineage = [
    { node: { kind: 'workbook' as const, refId: found.w.id, version: String(found.w.lockVersion) }, relation: 'exported_from' as const },
    ...reads.flatMap((r) => r.lineage),
  ];
  // Without a header row, the columns are named by their letters.
  const letters = (rows[0] ?? []).map((_, i) => columnName(Math.min(from.col, to.col) + i));
  return withHeader ? { header: rows[0] ?? [], rows: rows.slice(1), refused: null, lineage } : { header: letters, rows, refused: null, lineage };
}

/** Whether a member may open a workbook (a report's owner, embedding it). */
export async function opens(deps: WorkspaceDeps, me: Member, workbookId: string): Promise<WorkbookDocument | undefined> {
  return readable(deps, me, workbookId).then((f) => documentOf(f.w), () => undefined);
}

