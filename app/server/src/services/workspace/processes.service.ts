// Process analyses (D234): process mining over Silo's own reads. Events come from an object set
// whose objects are events (read with its case, activity and time properties, as the opener, like a
// workbook's live range) or from a state property's captured changes (Capture's history, read as
// the opener). The mining is processMining.service.ts, pure. Saved by its owner (process.save),
// shared like a workbook, read for whoever opens it, never stored; an export files a PDF of the
// analysis in Files with the markings of what it read.

import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { readHistory } from '../../contracts/siloes/siloes.contract.ts';
import { processDocument, type ProcessDocument } from '../../contracts/workspace/process.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ProcessAnalysis } from '../../models/workspace/processAnalysis.model.ts';
import { processAnalysisRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { PDF_CONTENT_TYPE, renderReportPdf, type ReportBlock } from '../render/pdf.service.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentHeld, type DocumentKind, type SharedDocument } from './documentShares.service.ts';
import { eventsFromTransitions, mine, type Mined, type ProcessEvent } from './processMining.service.ts';
import { readRange } from './workbooks.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
const notFound = () => new AppError('not_found', 'no such process analysis', { code: 'workspace.process_not_found' });
const stale = () => new AppError('conflict', 'the analysis changed since you read it', { code: 'workspace.process_stale' });
const refuse = (message: string, code: string) => new AppError('validation', message, { code });
const documentOf = (p: ProcessAnalysis): ProcessDocument => processDocument.parse(p.document);

const summaryOf = (p: ProcessAnalysis, held: DocumentHeld) => ({
  id: p.id, name: p.name, ownerMembershipId: p.ownerMembershipId, visibility: p.visibility, access: held,
  createdAt: p.createdAt, updatedAt: p.updatedAt, archivedAt: p.archivedAt, lockVersion: p.lockVersion,
});
const viewOf = (p: ProcessAnalysis, held: DocumentHeld) => ({ ...summaryOf(p, held), document: documentOf(p) });

export const PROCESS: DocumentKind<ProcessAnalysis> = {
  arm: 'process', notFound,
  findForUpdate: (db, id) => processAnalysisRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => processAnalysisRepo.update(db, id, { visibility }),
};
const kind = PROCESS as DocumentKind<SharedDocument>;

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ p: ProcessAnalysis; held: DocumentHeld }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await processAnalysisRepo.findById(db, id);
    const held = p === undefined ? undefined : await heldOn(db, kind, p, me.membershipId);
    return p === undefined || held === undefined ? undefined : { p, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

/** The source as the owner saves it: over a set and properties of its type they may see, or a property of a type they may see. */
async function checkSource(deps: WorkspaceDeps, ctx: Context, doc: ProcessDocument): Promise<void> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  const s = doc.source;
  if (s.kind === 'events') {
    let set: { baseTypeId: string | null };
    try {
      set = await deps.services.call(getObjectSet, { params: { objectSetId: s.objectSetId } }, options);
    } catch (error) {
      if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) throw refuse('the analysis reads an object set you may not see', 'workspace.process_set_unknown');
      throw error;
    }
    const known = new Set(manifest.objectTypes.find((t) => t.id === set.baseTypeId)?.properties.map((p) => p.identityId) ?? []);
    if (![s.caseProperty, s.activityProperty, s.timeProperty].every((p) => known.has(p))) throw refuse('a property the analysis names is not of its set\'s type', 'workspace.process_property_unknown');
  } else {
    const type = manifest.objectTypes.find((t) => t.id === s.objectTypeId);
    if (type === undefined || !type.properties.some((p) => p.identityId === s.propertyId)) throw refuse('the analysis names a property of a type you may not see', 'workspace.process_property_unknown');
  }
}

export async function create(deps: WorkspaceDeps, ctx: Context, input: { name: string; document: ProcessDocument }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'process.save' });
  await checkSource(deps, ctx, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await processAnalysisRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: input.name, document: input.document as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'process_analysis_created', resource: { type: 'process_analysis', id: p.id }, detail: { source: input.document.source.kind, copied_from: null } });
    return viewOf(p, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { processes: (await processAnalysisRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((p) => summaryOf(p, 'owner')) };
    const out: ReturnType<typeof summaryOf>[] = [];
    for (const p of await processAnalysisRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'process', me.membershipId), limit)) {
      const held = await heldOn(db, kind, p, me.membershipId);
      if (held !== undefined && held !== 'owner') out.push(summaryOf(p, held));
    }
    return { processes: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const { p, held } = await readable(deps, me, id);
  return viewOf(p, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { name?: string | undefined; document: ProcessDocument; lockVersion: number }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'process.save' });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => processAnalysisRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await checkSource(deps, ctx, input.document);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await processAnalysisRepo.findForUpdate(db, id);
    if (!p || p.ownerMembershipId !== me.membershipId) throw notFound();
    if (p.archivedAt !== null) throw new AppError('conflict', 'an archived analysis is not edited', { code: 'workspace.process_archived' });
    if (p.lockVersion !== input.lockVersion) throw stale();
    const saved = (await processAnalysisRepo.update(db, id, { ...(input.name === undefined ? {} : { name: input.name }), document: input.document as never, lockVersion: p.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'process_analysis_saved', resource: { type: 'process_analysis', id }, detail: { source: input.document.source.kind, reference: input.document.reference !== undefined },
    });
    return viewOf(saved, 'owner');
  });
}

interface Analysed extends Mined {
  refused: string | null; skipped: number; truncated: boolean; capturedFrom: string | null; lineage: { node: NodeRef; relation: Relation }[];
}
const empty = (refused: string): Analysed => ({
  ...mine([]), refused, skipped: 0, truncated: false, capturedFrom: null, lineage: [],
});

/** The events as the caller may read them, then mined. */
async function analyse(deps: WorkspaceDeps, ctx: Context, doc: ProcessDocument): Promise<Analysed> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const s = doc.source;
  if (s.kind === 'events') {
    const set = await deps.services.call(getObjectSet, { params: { objectSetId: s.objectSetId } }, options).catch(() => undefined);
    if (set === undefined) return empty('the object set is not one you may read');
    const read = await readRange(deps, ctx, { id: 'events', objectSetId: s.objectSetId, propertyIds: [s.caseProperty, s.activityProperty, s.timeProperty], limit: s.limit }, set.baseTypeId);
    if (read.refused !== null) return empty(read.refused);
    const events: ProcessEvent[] = [];
    let skipped = 0;
    for (const [c, a, t] of read.rows) {
      const at = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : NaN;
      if (c === null || c === undefined || a === null || a === undefined || !Number.isFinite(at)) { skipped += 1; continue; }
      events.push({ case: String(c), activity: typeof a === 'object' ? JSON.stringify(a) : String(a), at });
    }
    return { ...mine(events, doc.reference), refused: null, skipped, truncated: read.truncated, capturedFrom: null, lineage: read.lineage };
  }
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  const type = manifest.objectTypes.find((t) => t.id === s.objectTypeId);
  const property = type?.properties.find((p) => p.identityId === s.propertyId);
  if (type === undefined || property === undefined) return empty('the property is not one you may see');
  const history = await deps.services.call(readHistory, {
    body: { objectTypeId: s.objectTypeId, property: property.apiName, limit: s.limit, ...(s.from === undefined ? {} : { from: s.from }), ...(s.to === undefined ? {} : { to: s.to }) },
  }, options).then((h) => h, (error: unknown) => (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found') ? 'withheld' as const : 'unreachable' as const));
  if (history === 'unreachable') return empty('Capture could not be reached just now, so the history was not read');
  if (history === 'withheld' || history.state === 'withheld') return empty('the history is not yours to read');
  if (history.state === 'unavailable') return empty('no Capture Silo holds this type\'s history, so its changes were not kept');
  const events = eventsFromTransitions(history.transitions);
  const lineage = [
    { node: { kind: 'object_type_version' as const, refId: type.id, version: type.typeVersionId }, relation: 'exported_from' as const },
    // Read through the Capture Silo, as recognition records its reads of history: the Silo's markings travel too.
    ...(history.siloId === null ? [] : [{ node: { kind: 'silo' as const, refId: history.siloId, version: '1' }, relation: 'exported_from' as const }]),
  ];
  return { ...mine(events, doc.reference), refused: null, skipped: 0, truncated: history.have > history.transitions.length, capturedFrom: history.capturedFrom, lineage };
}

export async function analysis(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  const { p } = await readable(deps, me, id);
  const { lineage: _l, ...out } = await analyse(deps, ctx, documentOf(p));
  return { computedAt: new Date().toISOString(), ...out };
}

export async function copy(deps: WorkspaceDeps, ctx: Context, id: string, name: string) {
  const me = member(ctx);
  const { p, held } = await readable(deps, me, id);
  if (held === 'view') throw new AppError('forbidden', 'this analysis is shared with you to open, not to copy', { code: 'workspace.process_copy_not_shared' });
  await demand(deps, ctx, { permission: 'process.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const made = await processAnalysisRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: p.document as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'process_analysis_created', resource: { type: 'process_analysis', id: made.id }, detail: { source: documentOf(p).source.kind, copied_from: p.id } });
    return viewOf(made, 'owner');
  });
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const p = await processAnalysisRepo.findForUpdate(db, id);
    if (!p || p.ownerMembershipId !== me.membershipId) throw notFound();
    const done = p.archivedAt !== null ? p : (await processAnalysisRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: p.lockVersion + 1 }))!;
    if (p.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'process_analysis_archived', resource: { type: 'process_analysis', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

const asShare = <T extends { documentId: string }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, processId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'process.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => asShare(await shareDocument(db, me, ctx.correlationId, kind, id, input)));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => asShare(await revokeDocumentShare(db, me, ctx.correlationId, kind, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, kind, await processAnalysisRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}

const duration = (s: number | null): string => {
  if (s === null) return '';
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

export async function exportProcess(deps: WorkspaceDeps, ctx: Keyed, id: string, folderId: string | undefined): Promise<{ file: FileView }> {
  const me = member(ctx);
  const { p } = await readable(deps, me, id);
  const doc = documentOf(p);
  const a = await analyse(deps, ctx, doc);
  const inputs = [{ node: { kind: 'process_analysis' as const, refId: p.id, version: String(p.lockVersion) }, relation: 'exported_from' as const }, ...a.lineage];
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);
  const blocks: ReportBlock[] = [
    { kind: 'text', text: a.refused !== null ? `Not computed for you: ${a.refused}.`
      : `${a.cases} cases, ${a.events} events${a.skipped > 0 ? ` (${a.skipped} skipped: no case, activity or time)` : ''}${a.truncated ? ', over the first events read' : ''}. Case duration: median ${duration(a.caseDuration.medianSeconds)}, 90th percentile ${duration(a.caseDuration.p90Seconds)}.` },
    { kind: 'heading', text: 'Activities', level: 2 },
    { kind: 'table', caption: undefined, header: ['Activity', 'Events', 'Cases', 'Starts', 'Ends'], rows: a.activities.map((x) => [x.name, String(x.events), String(x.cases), String(x.starts), String(x.ends)]), note: undefined },
    { kind: 'heading', text: 'Steps', level: 2 },
    { kind: 'table', caption: undefined, header: ['From', 'To', 'Times', 'Cases', 'Median', '90th percentile'],
      rows: a.edges.slice(0, 60).map((e) => [e.from, e.to, String(e.count), String(e.cases), duration(e.medianSeconds), duration(e.p90Seconds)]), note: a.edges.length > 60 ? `The 60 most frequent of ${a.edges.length} steps.` : undefined },
    { kind: 'heading', text: 'Variants', level: 2 },
    { kind: 'table', caption: undefined, header: ['Path', 'Cases', 'Share', 'Median'], rows: a.variants.map((v) => [v.path.join(' > '), String(v.cases), `${Math.round(v.share * 100)}%`, duration(v.medianSeconds)]), note: undefined },
    ...(a.conformance === null ? [] : [
      { kind: 'heading' as const, text: 'Conformance', level: 2 as const },
      { kind: 'text' as const, text: `${a.conformance.fitting} cases fit the reference model; ${a.conformance.deviating} deviate.` },
      { kind: 'table' as const, caption: undefined, header: ['Step not in the model', 'Cases'], rows: a.conformance.deviations.map((d) => [`${d.from} > ${d.to}`, String(d.cases)]), note: undefined },
    ]),
  ];
  const bytes = renderReportPdf({ name: p.name, markings: markings.map((m) => m.name), computedAt: new Date().toISOString(), blocks });
  const file = await deps.services.call(createExport, {
    body: {
      name: `${p.name.slice(0, 190)}.pdf`, contentType: PDF_CONTENT_TYPE as 'application/pdf', content: bytes.toString('base64'), source: { kind: 'process_analysis', processAnalysisId: p.id },
      ...(folderId === undefined ? {} : { folderId }), inputs, printedMarkingIds: markings.map((m) => m.id), fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `process.${ctx.idempotencyKey ?? p.id}` });
  await inTransaction(deps.databases.pool('control'), me.request, (db: Queryable) => recordEvent(db, me, ctx.correlationId, {
    event: 'process_analysis_exported', resource: { type: 'process_analysis', id: p.id }, detail: { file_id: file.id, cases: a.cases, markings: markings.length },
  }));
  return { file };
}
