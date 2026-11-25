// Notebooks (D239): an analysis as cells, computed in order for whoever runs it, as them, with
// nothing read stored. Objects cells read saved object sets (readRange, as a workbook's live ranges
// are read); question cells run the plan compile made of the owner's question, with the values it
// bound (sealed by compile under the cell's binding), unmetered; transform cells run a pipeline's
// closed steps (pipelineEngine.service.ts) over earlier tables; statistics and charts are
// notebookEngine.service.ts. A cell whose table cannot be read says why, and so does each cell
// that reads it; the rest stand. Shared like a workbook; only the owner edits and asks.

import { createExport, previewExportMarkings, type FileView } from '../../contracts/files/file.contract.ts';
import { getCompiledPlan, runCompiledPlan, copyPlanBinding } from '../../contracts/compile/compile.contract.ts';
import { readResultPage, type QueryResult, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { NodeRef, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import { notebookDocument, type CellOutput, type NotebookCell, type NotebookDocument, type NotebookView } from '../../contracts/workspace/notebook.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Notebook } from '../../models/workspace/notebook.model.ts';
import { notebookRepo, viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { renderWorkbookXlsx } from '../render/xlsx.service.ts';
import { demand, member, recordEvent, type Context, type Member, type WorkspaceDeps } from './deps.service.ts';
import { documentShares, heldOn, revokeDocumentShare, shareDocument, type DocumentHeld, type DocumentKind, type SharedDocument } from './documentShares.service.ts';
import { chartOf, statsOf } from './notebookEngine.service.ts';
import { get as getModel, predictFor } from './mlModels.service.ts';
import { runSteps, StepError, type Cell, type Compile, type Table } from './pipelineEngine.service.ts';
import { readRange, typesOf } from './workbooks.service.ts';

type Keyed = Context & Pick<HandlerContext, 'idempotencyKey'>;
const notFound = () => new AppError('not_found', 'no such notebook', { code: 'workspace.notebook_not_found' });
const stale = () => new AppError('conflict', 'the notebook changed since you read it', { code: 'workspace.notebook_stale' });
const refuse = (message: string, code: string) => new AppError('validation', message, { code });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BOUNDS = { steps: 10_000, timeMs: 5 };
/** Rows a table cell shows; all it read go on to later cells. */
const SHOWN_ROWS = 200;
/** Rows a question's answer is read to. */
const ANSWER_ROWS = 50_000;

const compile: Compile = (expression, columns) => {
  const compiled = compileCel(expression, Object.fromEntries(columns.map((c) => [c, 'dyn' as const])));
  return (row) => compiled.evaluate(row, BOUNDS);
};

export const blankNotebook = (): NotebookDocument => ({ schemaVersion: '1', cells: [{ id: 'cell-1', kind: 'text', text: '' }] });
const documentOf = (n: Notebook): NotebookDocument => notebookDocument.parse(n.document);
function summaryOf(n: Notebook, held: DocumentHeld) {
  return {
    id: n.id, name: n.name, ownerMembershipId: n.ownerMembershipId, visibility: n.visibility, access: held,
    createdAt: n.createdAt, updatedAt: n.updatedAt, archivedAt: n.archivedAt, lockVersion: n.lockVersion,
  };
}
const viewOf = (n: Notebook, held: DocumentHeld): NotebookView => ({ ...summaryOf(n, held), document: documentOf(n) });

export const NOTEBOOK: DocumentKind<Notebook> = {
  arm: 'notebook', notFound,
  findForUpdate: (db, id) => notebookRepo.findForUpdate(db, id),
  setVisibility: (db, id, visibility) => notebookRepo.update(db, id, { visibility }),
};
const accessTo = (db: Queryable, n: Notebook, membershipId: string) => heldOn(db, NOTEBOOK as DocumentKind<SharedDocument>, n, membershipId);

async function readable(deps: WorkspaceDeps, me: Member, id: string): Promise<{ n: Notebook; held: DocumentHeld }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const n = await notebookRepo.findById(db, id);
    const held = n === undefined ? undefined : await accessTo(db, n, me.membershipId);
    return n === undefined || held === undefined ? undefined : { n, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

/**
 * The owner's document: each objects cell over a set and properties the owner may see; each
 * question cell's plan and binding the ones it was asked with (only asking sets them), or not yet
 * asked. A cell copied in from elsewhere keeps no plan.
 */
async function checkDocument(deps: WorkspaceDeps, ctx: Context, doc: NotebookDocument, saved: NotebookDocument | undefined): Promise<void> {
  for (const cell of doc.cells) {
    if (cell.kind !== 'question' || cell.planId === null) continue;
    const before = saved?.cells.find((c) => c.id === cell.id);
    if (before?.kind !== 'question' || before.planId !== cell.planId || before.bindingId !== cell.bindingId) {
      throw refuse('a question cell\'s plan is set by asking it', 'workspace.notebook_plan_not_asked');
    }
  }
  // A predict cell's model is one its owner may see (D242); whoever runs it must hold what the model learnt under.
  for (const cell of doc.cells) if (cell.kind === 'predict') await getModel(deps, ctx, cell.mlModelId);
  const objects = doc.cells.filter((c): c is Extract<NotebookCell, { kind: 'objects' }> => c.kind === 'objects');
  if (objects.length === 0) return;
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const manifest = await deps.services.call(getManifest, { query: {} }, options);
  for (const cell of objects) {
    let set: { baseTypeId: string | null };
    try {
      set = await deps.services.call(getObjectSet, { params: { objectSetId: cell.objectSetId } }, options);
    } catch (error) {
      if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) throw refuse(`${cell.name} reads an object set you may not see`, 'workspace.notebook_set_unknown');
      throw error;
    }
    const known = new Set(manifest.objectTypes.find((t) => t.id === set.baseTypeId)?.properties.map((p) => p.identityId) ?? []);
    if (cell.propertyIds.some((p) => !known.has(p))) throw refuse(`${cell.name} names a property its set's type does not have`, 'workspace.notebook_property_unknown');
  }
}

export async function create(deps: WorkspaceDeps, ctx: Context, name: string): Promise<NotebookView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'notebook.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const n = await notebookRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: blankNotebook() as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'notebook_created', resource: { type: 'notebook', id: n.id }, detail: { copied_from: null } });
    return viewOf(n, 'owner');
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (filter !== 'shared') return { notebooks: (await notebookRepo.listMine(db, me.membershipId, filter === 'archived', limit)).map((n) => summaryOf(n, 'owner')) };
    const out: ReturnType<typeof summaryOf>[] = [];
    for (const n of await notebookRepo.listByIds(db, await viewShareRepo.documentsReaching(db, 'notebook', me.membershipId), limit)) {
      const held = await accessTo(db, n, me.membershipId);
      if (held !== undefined && held !== 'owner') out.push(summaryOf(n, held));
    }
    return { notebooks: out };
  }, { readOnly: true });
}

export async function get(deps: WorkspaceDeps, ctx: Context, id: string): Promise<NotebookView> {
  const me = member(ctx);
  const { n, held } = await readable(deps, me, id);
  return viewOf(n, held);
}

export async function save(deps: WorkspaceDeps, ctx: Context, id: string, input: { name?: string | undefined; document: NotebookDocument; lockVersion: number }): Promise<NotebookView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'notebook.save' });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => notebookRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  await checkDocument(deps, ctx, input.document, documentOf(current));
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const n = await notebookRepo.findForUpdate(db, id);
    if (!n || n.ownerMembershipId !== me.membershipId) throw notFound();
    if (n.archivedAt !== null) throw new AppError('conflict', 'an archived notebook is not edited', { code: 'workspace.notebook_archived' });
    if (n.lockVersion !== input.lockVersion) throw stale();
    const saved = (await notebookRepo.update(db, id, { ...(input.name === undefined ? {} : { name: input.name }), document: input.document as never, lockVersion: n.lockVersion + 1 }))!;
    const kinds = input.document.cells.reduce<Record<string, number>>((m, c) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {});
    await recordEvent(db, me, ctx.correlationId, { event: 'notebook_saved', resource: { type: 'notebook', id }, detail: { cells: input.document.cells.length, ...Object.fromEntries(Object.entries(kinds).map(([k, v]) => [`${k}_cells`, v])) } });
    return viewOf(saved, 'owner');
  });
}

/** A question cell asked by its owner: compiled (and charged) by compile, its values bound under a fresh binding, the plan saved into the cell. */
export async function ask(deps: WorkspaceDeps, ctx: Keyed, id: string, input: {
  cellId: string; question: string; lockVersion: number;
  chosen?: { option: { id: string; kind: string; elementId: string; label: string; source: string | null }; rejected: { id: string; kind: string; elementId: string; label: string; source: string | null }[] } | undefined;
}) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'notebook.save' });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => notebookRepo.findById(db, id), { readOnly: true });
  if (!current || current.ownerMembershipId !== me.membershipId) throw notFound();
  if (current.lockVersion !== input.lockVersion) throw stale();
  const cell = documentOf(current).cells.find((c) => c.id === input.cellId);
  if (cell?.kind !== 'question') throw refuse('ask in a saved question cell', 'workspace.notebook_cell_unknown');
  const bindingId = uuidv7();
  const compiled = await deps.engine.compile({
    // A notebook asks; it never proposes a change.
    question: input.question, tool: 'find_objects', scope: null, priorManifestIds: [], advanced: false, turnId: bindingId,
    chargeKey: `nb.${sha256(`${id}:${input.cellId}:${ctx.idempotencyKey ?? bindingId}`).toString('hex').slice(0, 48)}`,
    ...(input.chosen === undefined ? {} : { chosen: input.chosen.option as never, rejected: input.chosen.rejected as never }),
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (compiled.outcome === 'clarification') return { outcome: 'clarification' as const, options: compiled.options as never };
  if (compiled.outcome === 'refusal') return { outcome: 'refusal' as const, reason: compiled.reason, narrowing: compiled.narrowing };
  if (compiled.outcome !== 'plan') return { outcome: 'refusal' as const, reason: 'no_plan', narrowing: 'ask for objects or figures, not for a change' };
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const n = await notebookRepo.findForUpdate(db, id);
    if (!n || n.ownerMembershipId !== me.membershipId) throw notFound();
    if (n.lockVersion !== input.lockVersion) throw stale();
    const doc = documentOf(n);
    const next: NotebookDocument = { ...doc, cells: doc.cells.map((c) => (c.id === input.cellId && c.kind === 'question' ? { ...c, planId: compiled.manifestId, bindingId } : c)) };
    const saved = (await notebookRepo.update(db, id, { document: next as never, lockVersion: n.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'notebook_question_compiled', resource: { type: 'notebook', id }, detail: { cell_id: input.cellId, manifest_id: compiled.manifestId, tokens_charged: compiled.tokensCharged },
    });
    return { outcome: 'plan' as const, notebook: viewOf(saved, 'owner'), tokensCharged: compiled.tokensCharged };
  });
}

// ----------------------------------------------------------------------------- running

const cellOf = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v));

/** An answer as a table: a group's keys and measures, or each object's values in the order the answer names its columns. */
function answerTable(result: QueryResult, objects: ResultObject[]): { table: Table; withheld: number } {
  if (result.kind === 'groups') {
    const first = result.page.groups[0];
    const keys = first === undefined ? [] : Object.keys(first.key);
    const measures = result.measures.map((m) => m.as);
    return { table: { columns: [...keys, ...measures], rows: result.page.groups.map((g) => [...keys.map((k) => cellOf(g.key[k])), ...measures.map((m) => cellOf(g.measures[m]))]) }, withheld: 0 };
  }
  const columns = result.columns.map((c) => c.apiName);
  const hidden = new Set(result.columns.filter((c) => c.effect !== 'allow').map((c) => c.apiName));
  return {
    table: { columns, rows: objects.map((o) => columns.map((c) => (hidden.has(c) || o.masked.includes(c) || o.redacted.includes(c) ? null : cellOf(o.values[c])))) },
    withheld: hidden.size,
  };
}

interface Computed { outputs: CellOutput[]; tables: Map<string, Table>; lineage: { node: NodeRef; relation: Relation }[]; refused: number }

/** Every cell computed in order for the caller. */
async function compute(deps: WorkspaceDeps, ctx: Context, doc: NotebookDocument): Promise<Computed> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const tables = new Map<string, Table>();
  const lineage = new Map<string, { node: NodeRef; relation: Relation }>();
  const outputs: CellOutput[] = [];
  let refused = 0;
  const manifest = doc.cells.some((c) => c.kind === 'objects') ? await deps.services.call(getManifest, { query: {} }, options) : undefined;
  const apiName = new Map(manifest?.objectTypes.flatMap((t) => t.properties.map((p) => [p.identityId, p.apiName] as const)) ?? []);
  const types = await typesOf(deps, ctx, doc.cells.flatMap((c) => (c.kind === 'objects' ? [c.objectSetId] : [])));
  const shown = (t: Table, total: number, withheld: number, note: string | null = null): CellOutput['output'] => ({
    kind: 'table', columns: t.columns, rows: t.rows.slice(0, SHOWN_ROWS), total, truncated: total > SHOWN_ROWS, withheld, note,
  });
  const missing = (name: string) => `its table ${name} could not be made`;
  for (const cell of doc.cells) {
    const out = (output: CellOutput['output'], why: string | null = null) => {
      if (why !== null) refused += 1;
      outputs.push({ cellId: cell.id, refused: why, output: why === null ? output : null });
    };
    try {
      if (cell.kind === 'text') { out(null); continue; }
      if (cell.kind === 'objects') {
        const read = await readRange(deps, ctx, { id: cell.id, objectSetId: cell.objectSetId, propertyIds: cell.propertyIds, limit: cell.limit }, types.get(cell.objectSetId));
        if (read.refused !== null) { out(null, read.refused); continue; }
        const columns = cell.propertyIds.map((p) => apiName.get(p) ?? p);
        const table: Table = cell.withIds
          ? { columns: ['object_id', ...columns], rows: read.rows.map((r, i) => [read.ids[i] ?? null, ...r.map(cellOf)]) }
          : { columns, rows: read.rows.map((r) => r.map(cellOf)) };
        tables.set(cell.name, table);
        for (const l of read.lineage) lineage.set(`${l.node.kind}${l.node.refId}${l.node.version}`, l);
        out(shown(table, read.total, read.withheld));
        continue;
      }
      if (cell.kind === 'question') {
        if (cell.planId === null) { out(null, 'not asked yet'); continue; }
        const ran = await deps.services.call(runCompiledPlan, { params: { planId: cell.planId }, body: { trigger: 'saved_view_run', bindingId: cell.bindingId } }, options);
        if (ran.outcome === 'refusal') { out(null, ran.refusal.reason); continue; }
        const objects = [...ran.result.page.objects];
        for (let page = 1; page < ran.result.page.count && objects.length < ANSWER_ROWS; page++) {
          objects.push(...(await deps.services.call(readResultPage, { params: { queryId: ran.result.queryId, page } }, options)).objects);
        }
        const { table, withheld } = answerTable(ran.result, objects);
        tables.set(cell.name, table);
        // The type versions and connections it read, for an export's markings.
        const plan = await deps.services.call(getCompiledPlan, { params: { planId: cell.planId } }, options).catch(() => undefined);
        for (const column of ran.result.lineage) {
          const typeId = plan?.plan.nodes[column.node]?.objectTypeId;
          if (typeId !== undefined) lineage.set(`t${column.objectTypeVersionId}`, { node: { kind: 'object_type_version', refId: typeId, version: column.objectTypeVersionId }, relation: 'exported_from' });
          for (const s of column.sources) lineage.set(`c${s.connectionId}${s.connectorVersion}`, { node: { kind: 'connection', refId: s.connectionId, version: s.connectorVersion }, relation: 'exported_from' });
        }
        out(shown(table, ran.result.total, withheld));
        continue;
      }
      if (cell.kind === 'predict') {
        const scored = await predictFor(deps, ctx, cell.mlModelId, { ...(cell.objectSetId === null ? {} : { objectSetId: cell.objectSetId }), limit: cell.limit });
        const table: Table = scored.task === 'classification'
          ? { columns: ['object_id', 'prediction', 'confidence'], rows: scored.predictions.map((p) => [p.objectId, p.value, p.probability]) }
          : { columns: ['object_id', 'prediction'], rows: scored.predictions.map((p) => [p.objectId, p.value]) };
        tables.set(cell.name, table);
        for (const l of scored.lineage) lineage.set(`${l.node.kind}${l.node.refId}${l.node.version}`, l);
        const shifted = scored.drift.filter((d) => d.level !== 'stable');
        out(shown(table, scored.total, scored.withheld, shifted.length === 0 ? null
          : `these objects differ from what the model learnt from in ${shifted.map((d) => `${d.feature} (${d.level})`).join(', ')}`));
        continue;
      }
      if (cell.kind === 'transform') {
        const reads = [cell.input, ...cell.steps.flatMap((s) => (s.op === 'join' ? [s.input] : []))];
        const gone = reads.find((r) => !tables.has(r));
        if (gone !== undefined) { out(null, missing(gone)); continue; }
        const table = runSteps(tables, cell.input, cell.steps, compile);
        tables.set(cell.name, table);
        out(shown(table, table.rows.length, 0));
        continue;
      }
      const source = tables.get(cell.source);
      if (source === undefined) { out(null, missing(cell.source)); continue; }
      if (cell.kind === 'stats') out({ kind: 'stats', columns: statsOf(source, cell.columns) });
      else out(chartOf(source, cell));
    } catch (error) {
      if (error instanceof StepError) { out(null, `step ${error.step}: ${error.message}`); continue; }
      if (error instanceof Error && /^there is no column|plots a y column/.test(error.message)) { out(null, error.message); continue; }
      if (isAppError(error) && ['not_found', 'forbidden', 'bounds', 'validation', 'conflict'].includes(error.category)) { out(null, error.message); continue; }
      throw error;
    }
  }
  return { outputs, tables, lineage: [...lineage.values()], refused };
}

/** Computed now for the caller. The owner may run a draft they have not saved; anyone else runs what was saved. */
export async function run(deps: WorkspaceDeps, ctx: Context, id: string, draft: NotebookDocument | undefined) {
  const me = member(ctx);
  const { n, held } = await readable(deps, me, id);
  let doc = documentOf(n);
  if (draft !== undefined) {
    if (held !== 'owner') throw new AppError('forbidden', 'only its owner runs a notebook they have not saved', { code: 'workspace.notebook_draft_not_yours' });
    await checkDocument(deps, ctx, draft, doc);
    doc = draft;
  }
  const { outputs } = await compute(deps, ctx, doc);
  return { outputs, computedAt: new Date().toISOString() };
}

export async function copy(deps: WorkspaceDeps, ctx: Keyed, id: string, name: string): Promise<NotebookView> {
  const me = member(ctx);
  const { n, held } = await readable(deps, me, id);
  if (held === 'view') throw new AppError('forbidden', 'this notebook is shared with you to open, not to copy', { code: 'workspace.notebook_copy_not_shared' });
  await demand(deps, ctx, { permission: 'notebook.save' });
  // Each compiled question's bound values copied under a binding of the copy's own.
  const doc = documentOf(n);
  const cells: NotebookCell[] = [];
  for (const c of doc.cells) {
    if (c.kind !== 'question' || c.planId === null) { cells.push(c); continue; }
    const bindingId = uuidv7();
    await deps.services.call(copyPlanBinding, { params: { bindingId: c.bindingId }, body: { toBindingId: bindingId } }, { request: ctx.request, correlationId: ctx.correlationId });
    cells.push({ ...c, bindingId });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const made = await notebookRepo.insert(db, { id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name, document: { ...doc, cells } as never });
    await recordEvent(db, me, ctx.correlationId, { event: 'notebook_created', resource: { type: 'notebook', id: made.id }, detail: { copied_from: n.id } });
    return viewOf(made, 'owner');
  });
}

export async function archive(deps: WorkspaceDeps, ctx: Context, id: string): Promise<NotebookView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const n = await notebookRepo.findForUpdate(db, id);
    if (!n || n.ownerMembershipId !== me.membershipId) throw notFound();
    const done = n.archivedAt !== null ? n : (await notebookRepo.update(db, id, { archivedAt: new Date().toISOString(), lockVersion: n.lockVersion + 1 }))!;
    if (n.archivedAt === null) await recordEvent(db, me, ctx.correlationId, { event: 'notebook_archived', resource: { type: 'notebook', id }, detail: {} });
    return viewOf(done, 'owner');
  });
}

// ----------------------------------------------------------------------------- sharing (37.4, as saved views)

const asShare = <T extends { documentId: string }>(v: T) => { const { documentId, ...rest } = v; return { ...rest, notebookId: documentId }; };

export async function share(deps: WorkspaceDeps, ctx: Context, id: string, input: { grantee: ShareGrantee; access: 'view' | 'copy'; expiresAt?: string | undefined }) {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'notebook.save' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await shareDocument(db, me, ctx.correlationId, NOTEBOOK as DocumentKind<SharedDocument>, id, input)));
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, id: string, shareId: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    asShare(await revokeDocumentShare(db, me, ctx.correlationId, NOTEBOOK as DocumentKind<SharedDocument>, id, shareId)));
}

export async function shares(deps: WorkspaceDeps, ctx: Context, id: string) {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    ({ shares: (await documentShares(db, me, NOTEBOOK as DocumentKind<SharedDocument>, await notebookRepo.findById(db, id))).map(asShare) }), { readOnly: true });
}

// ----------------------------------------------------------------------------- export

export async function exportNotebook(deps: WorkspaceDeps, ctx: Keyed, id: string, folderId: string | undefined): Promise<{ file: FileView }> {
  const me = member(ctx);
  const { n } = await readable(deps, me, id);
  const doc = documentOf(n);
  const computed = await compute(deps, ctx, doc);
  const inputs = [{ node: { kind: 'notebook' as const, refId: n.id, version: String(n.lockVersion) }, relation: 'exported_from' as const }, ...computed.lineage];
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { markings } = await deps.services.call(previewExportMarkings, { body: { inputs } }, options);
  // A sheet per table, in the notebook's order, and one of the statistics.
  const sheets: { name: string; rows: unknown[][] }[] = [];
  for (const cell of doc.cells) {
    if ('name' in cell && computed.tables.has(cell.name)) {
      const t = computed.tables.get(cell.name)!;
      sheets.push({ name: cell.name, rows: [t.columns, ...t.rows] });
    }
    const output = computed.outputs.find((o) => o.cellId === cell.id)?.output;
    if (cell.kind === 'stats' && output?.kind === 'stats') {
      sheets.push({
        name: `${cell.source}_stats`,
        rows: [['column', 'count', 'empty', 'distinct', 'min', 'max', 'mean', 'median', 'p90', 'stddev'],
          ...output.columns.map((c) => [c.name, c.count, c.empty, c.distinct, c.numeric?.min ?? null, c.numeric?.max ?? null, c.numeric?.mean ?? null, c.numeric?.median ?? null, c.numeric?.p90 ?? null, c.numeric?.stddev ?? null])],
      });
    }
  }
  const notes = computed.refused === 0 ? [] : [`${computed.refused} cell${computed.refused === 1 ? ' was' : 's were'} not computed for you, so ${computed.refused === 1 ? 'it is' : 'they are'} left out`];
  const bytes = renderWorkbookXlsx(sheets, markings.map((m) => m.name), notes);
  const file = await deps.services.call(createExport, {
    body: {
      name: `${n.name.slice(0, 190)}.xlsx`, contentType: XLSX, content: bytes.toString('base64'), source: { kind: 'notebook', notebookId: n.id },
      ...(folderId === undefined ? {} : { folderId }), inputs, printedMarkingIds: markings.map((m) => m.id), fieldPolicies: [], connectionIds: [],
    },
  }, { ...options, idempotencyKey: `notebook.${ctx.idempotencyKey ?? n.id}` });
  await inTransaction(deps.databases.pool('control'), me.request, (db) => recordEvent(db, me, ctx.correlationId, {
    event: 'notebook_exported', resource: { type: 'notebook', id: n.id }, detail: { file_id: file.id, sheets: sheets.length, refused: computed.refused, markings: markings.length },
  }));
  return { file };
}
