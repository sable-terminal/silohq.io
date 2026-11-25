// Wipes (spec 70.2, 70.3): distinct actions, never one button.
//
//   entity   one object's transitions                       Capture
//   file     one file, its rows and its extracted values    Import
//   object   an imported object's rows                      Import
//   index    one type's entries, or the whole index         Object Index
//   concept  one object type, in every Silo holding it      all
//   silo     the whole Silo, files included; then disabled  all
//
// Every wipe: (1) drains the capture queue first, audited; (2) routes through an approval
// chain where the organisation has a default approval policy (as discovery does), approvers
// holding silo.purge, and otherwise the requester is the approver; (3) deletes from every
// store the scope touches; (4) leaves a receipt of references and counts, never values, in
// siloes.purge_receipts and the audit trail; (5) states what stops working, before and after.
// Findings already raised stand: they hold references and counts, not values.

import { retireSiloSource } from '../../contracts/connect-registry/siloSource.contract.ts';
import { createHash } from 'node:crypto';
import { recordUploadsPurged } from '../../contracts/files/file.contract.ts';
import { purgeObjectIndex } from '../../contracts/index-builder/index.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { dropImportDataset, purgeImportFile, purgeImportObject } from '../../contracts/import-loader/load.contract.ts';
import type { StoredLedgerEntry } from '../../contracts/platform/purgeLedger.contract.ts';
import type { PurgeImpact, PurgeScope, PurgeView } from '../../contracts/siloes/siloes.contract.ts';
import { outboxRepo } from '../../repos/platform/outbox.repo.ts';
import { purgeWarehouse, purgeWarehouseType } from '../../contracts/warehouse/access.contract.ts';
import type { ObjectKey, ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { PurgeReceipt, PurgeRequest, Silo } from '../../models/siloes/index.model.ts';
import { approvalChainRepo, approvalPolicyRepo, approvalStepRepo } from '../../repos/action/index.repo.ts';
import {
  indexDefinitionRepo, purgeReceiptRepo, purgeRequestRepo, siloExtractionRepo, siloFileRepo, siloObjectTypeRepo, siloRepo, siloSourceRepo,
  transitionRepo, warehouseProjectRepo,
} from '../../repos/siloes/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { storedConditions } from '../approvals/snapshot.service.ts';
import { demand, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { purgeSpatialForFiles } from '../canvas-layout/spatial.service.ts';
import { drainSilo } from './capture.service.ts';
import { loadSilo, person, requireSiloes, type Context, type SiloesDeps } from './deps.service.ts';

/** A wipe step a store refused for a moment (unreachable, timed out, at capacity) is tried this many times, waiting a little longer each time. */
const WIPE_ATTEMPTS = 4;
const WIPE_RETRY_MS = 500;

export interface PurgeDeps extends SiloesDeps {
  /** gcs-siloes: Import files. */
  store: ObjectStore | undefined;
}

const HISTORY_DETECTORS = ['timing_deviation', 'drift', 'recurrence'] as const;
const CHAIN_HOURS = 24;
const CONDITION = 'purge';

interface Target {
  scope: PurgeScope;
  objectTypeId?: string | undefined;
  fileId?: string | undefined;
  objectRef?: string | undefined;
}

/** The scope fits the Silo's kind and names what it needs. */
function checkScope(silo: Silo, t: Target): void {
  const refuse = (message: string) => { throw new AppError('validation', message, { code: 'siloes.purge_scope' }); };
  const kinds: Record<PurgeScope, Silo['kind'][]> = {
    entity: ['capture'], file: ['import'], object: ['import'], index: ['object_index'], concept: ['capture', 'import', 'object_index', 'warehouse'],
    silo: ['capture', 'import', 'object_index', 'warehouse'],
  };
  if (!kinds[t.scope].includes(silo.kind)) refuse(`a ${t.scope} purge does not apply to a ${silo.kind} Silo`);
  if ((t.scope === 'entity' || t.scope === 'concept') && t.objectTypeId === undefined) refuse(`a ${t.scope} purge names the object type`);
  if ((t.scope === 'entity' || t.scope === 'object') && t.objectRef === undefined) refuse(`a ${t.scope} purge names the ${t.scope === 'entity' ? 'object' : 'definition object'}`);
  if (t.scope === 'file' && t.fileId === undefined) refuse('a file purge names the file');
  if (t.scope !== 'entity' && t.scope !== 'object' && t.objectRef !== undefined) refuse(`a ${t.scope} purge takes no object reference`);
  if (t.scope !== 'file' && t.fileId !== undefined) refuse(`a ${t.scope} purge takes no file`);
  if ((t.scope === 'file' || t.scope === 'object' || t.scope === 'silo') && t.objectTypeId !== undefined) refuse(`a ${t.scope} purge takes no object type`);
}

/** The Siloes a wipe reaches: the one asked about, or for a concept every live Silo holding the type. */
async function reached(db: Queryable, silo: Silo, t: Target): Promise<Silo[]> {
  if (t.scope !== 'concept') return [silo];
  const out = new Map<string, Silo>([[silo.id, silo]]);
  const siloes = await siloRepo.list(db, false);
  for (const s of siloes) {
    if (s.kind === 'object_index') {
      if ((await indexDefinitionRepo.listForSilo(db, s.id, true)).some((d) => d.objectTypeId === t.objectTypeId)) out.set(s.id, s);
    } else if (await siloObjectTypeRepo.findLive(db, s.id, t.objectTypeId!) !== undefined) {
      out.set(s.id, s);
    }
  }
  return [...out.values()];
}

/** What stops working (70.3 step 5), stated before and kept on the receipt. */
async function impactOf(db: Queryable, siloes: Silo[], t: Target): Promise<PurgeImpact> {
  const impact: PurgeImpact = { detectors: [], timelines: [], leadTimes: [], searchRoutes: [], warehouse: false, importedRows: false };
  for (const s of siloes) {
    if (s.kind === 'capture') {
      const types = t.objectTypeId !== undefined ? [t.objectTypeId] : (await siloObjectTypeRepo.listLive(db, s.id)).map((n) => n.objectTypeId);
      for (const type of types) {
        for (const detector of HISTORY_DETECTORS) impact.detectors.push({ detector, objectTypeId: type });
        impact.timelines.push(type);
        impact.leadTimes.push(type);
      }
    } else if (s.kind === 'object_index') {
      const types = t.objectTypeId !== undefined ? [t.objectTypeId] : (await indexDefinitionRepo.listForSilo(db, s.id, true)).map((d) => d.objectTypeId);
      impact.searchRoutes.push(...types);
    } else if (s.kind === 'warehouse') {
      impact.warehouse = true;
    } else {
      impact.importedRows = t.scope !== 'concept';
    }
  }
  const unique = <T>(xs: T[]) => [...new Set(xs)];
  return { ...impact, timelines: unique(impact.timelines), leadTimes: unique(impact.leadTimes), searchRoutes: unique(impact.searchRoutes) };
}

/** The organisation default approval policy decides whether a purge needs a chain. */
async function approvalsRequired(db: Queryable): Promise<{ required: number; hours: number; sources: string[] }> {
  const defaults = (await approvalPolicyRepo.listLive(db)).filter((p) => p.connectionId === null && p.scopeId === null && p.approvalsRequired > 0);
  return {
    required: defaults.length === 0 ? 0 : Math.max(...defaults.map((p) => p.approvalsRequired)),
    hours: Math.min(CHAIN_HOURS, ...defaults.map((p) => p.expiryHours)),
    sources: defaults.map((p) => p.id),
  };
}

/** The wipe an approval names: its hash is what an approver quotes. */
export function purgeDocument(r: Pick<PurgeRequest, 'id' | 'organisationId' | 'siloId' | 'scope' | 'objectTypeId' | 'siloFileId' | 'objectRef'>): Buffer {
  return createHash('sha256').update(canonicalJson({
    purge: r.id, organisation: r.organisationId, silo: r.siloId, scope: r.scope, objectType: r.objectTypeId, file: r.siloFileId, object: r.objectRef,
  })).digest();
}

function view(r: PurgeRequest, impact: PurgeImpact, receipt: PurgeReceipt | undefined): PurgeView {
  return {
    id: r.id, siloId: r.siloId, scope: r.scope, objectTypeId: r.objectTypeId, fileId: r.siloFileId, objectRef: r.objectRef, status: r.status,
    approvalChainId: r.approvalChainId, documentHash: r.approvalChainId === null ? null : purgeDocument(r).toString('hex'), requestedAt: r.requestedAt, completedAt: r.completedAt, failureStage: r.failureStage, impact,
    receipt: receipt === undefined ? null : {
      id: receipt.id, removed: receipt.removed as Record<string, unknown>, counts: receipt.counts as Record<string, number>, completedAt: receipt.completedAt,
    },
  };
}

async function prepare(deps: PurgeDeps, ctx: Context, siloId: string, t: Target) {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.purge', 'siloes.not_permitted');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = await loadSilo(db, siloId);
    if (silo.status === 'disabled') throw new AppError('conflict', 'the Silo was already disabled and purged', { code: 'siloes.closed' });
    checkScope(silo, t);
    if (t.fileId !== undefined) {
      const file = await siloFileRepo.findById(db, t.fileId);
      if (file === undefined || file.siloId !== silo.id) throw new AppError('not_found', 'no such file in this Silo', { code: 'siloes.file_not_found' });
    }
    const siloes = await reached(db, silo, t);
    return { silo, impact: await impactOf(db, siloes, t), approvals: await approvalsRequired(db) };
  }, { readOnly: true });
}

export async function previewPurge(deps: PurgeDeps, ctx: Context, siloId: string, t: Target): Promise<{ impact: PurgeImpact; approvalsRequired: number }> {
  const { impact, approvals } = await prepare(deps, ctx, siloId, t);
  return { impact, approvalsRequired: approvals.required };
}

export async function requestPurge(deps: PurgeDeps, ctx: Context, siloId: string, t: Target): Promise<PurgeView> {
  const { silo, impact, approvals } = await prepare(deps, ctx, siloId, t);
  const requester = person(ctx);
  const id = uuidv7();
  const now = new Date(deps.now());
  const request = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const chainId = approvals.required > 0 ? uuidv7() : null;
    // The request first, its chain next, then the request names its chain (each key points at a row that exists).
    let row = await purgeRequestRepo.insert(db, {
      id, organisationId: silo.organisationId, siloId: silo.id, scope: t.scope, objectTypeId: t.objectTypeId ?? null, siloFileId: t.fileId ?? null,
      objectRef: t.objectRef ?? null, requestedBy: requester,
    });
    if (chainId !== null) {
      // Approvers other than the requester, holding silo.purge (approvals checks it).
      const condition = {
        id: CONDITION, count: approvals.required, qualification: 'any_permitted' as const, qualifyingRoleId: null, requiresAdmin: false,
        selfApprovalPermitted: false, connectionIds: [], sources: approvals.sources,
      };
      await approvalChainRepo.insert(db, {
        id: chainId, organisationId: silo.organisationId, subjectKind: 'purge', purgeRequestId: id, requesterMembershipId: requester,
        policySnapshot: { conditions: storedConditions([condition]), sequential: false, subject: 'purge', scope: t.scope } as never,
        diffHash: purgeDocument(row), approvalsRequired: approvals.required, status: 'pending', expiresAt: new Date(now.getTime() + approvals.hours * 3_600_000).toISOString(),
      });
      for (let n = 0; n < approvals.required; n++) {
        await approvalStepRepo.insert(db, { id: uuidv7(), organisationId: silo.organisationId, chainId, sequence: null, qualifyingRule: CONDITION, offeredAt: now.toISOString() });
      }
      row = (await purgeRequestRepo.update(db, id, { approvalChainId: chainId }))!;
    } else {
      // No chain configured: the requester is the approver.
      row = (await purgeRequestRepo.update(db, id, { status: 'approved', decidedAt: now.toISOString() }))!;
    }
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'purge_requested', resource: { type: 'silo', id: silo.id },
      detail: { purge_id: id, scope: t.scope, object_type_id: t.objectTypeId ?? null, file_id: t.fileId ?? null, approvals_required: approvals.required },
      service: 'siloes-capture',
    });
    return row;
  });
  if (request.status === 'approved') startPurge(deps, request, ctx.correlationId);
  return view(request, impact, undefined);
}

/** A Silo's purges, newest first, without their impact (D270). */
export async function listPurges(deps: PurgeDeps, ctx: Context, siloId: string, limit: number) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.purge', 'siloes.not_permitted');
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await loadSilo(db, siloId);
    return purgeRequestRepo.listForSilo(db, siloId, limit);
  }, { readOnly: true });
  return {
    purges: rows.map((r) => ({
      id: r.id, scope: r.scope, objectTypeId: r.objectTypeId, fileId: r.siloFileId, objectRef: r.objectRef, status: r.status, approvalChainId: r.approvalChainId,
      requestedBy: r.requestedBy, requestedAt: r.requestedAt, completedAt: r.completedAt, failureStage: r.failureStage, receipt: r.hasReceipt,
    })),
  };
}

export async function getPurge(deps: PurgeDeps, ctx: Context, siloId: string, purgeId: string): Promise<PurgeView> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.purge', 'siloes.not_permitted');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const r = await purgeRequestRepo.findById(db, purgeId);
    if (r === undefined || r.siloId !== siloId) throw new AppError('not_found', 'no such purge', { code: 'siloes.purge_not_found' });
    const receipt = await purgeReceiptRepo.findByPurgeRequestId(db, { organisationId: r.organisationId, purgeRequestId: r.id });
    const impact = receipt !== undefined ? receipt.impact as PurgeImpact
      : await impactOf(db, await reached(db, await loadSilo(db, r.siloId), { scope: r.scope, objectTypeId: r.objectTypeId ?? undefined }),
        { scope: r.scope, objectTypeId: r.objectTypeId ?? undefined });
    return view(r, impact, receipt);
  }, { readOnly: true });
}

function startPurge(deps: PurgeDeps, request: PurgeRequest, correlationId: string): void {
  void runPurge(deps, request.organisationId, request.id, correlationId).catch((error: unknown) => {
    deps.logger.failure('a purge stopped outside its record', error, { event: 'siloes.purge_crashed', organisationId: request.organisationId });
  });
}

/** The approval watcher: approved chains run their purge; rejected or expired ones end it. */
export async function advancePurges(deps: PurgeDeps, correlationId: string): Promise<number> {
  const open = await inTransaction(deps.databases.pool('control'), {}, (db) => purgeRequestRepo.listOpen(db, 200), { readOnly: true });
  let started = 0;
  for (const o of open) {
    const scope: RequestContext = { organisationId: o.organisationId };
    const next = await inTransaction(deps.databases.pool('control'), scope, async (db) => {
      const r = await purgeRequestRepo.findById(db, o.id);
      if (r === undefined) return undefined;
      if (r.status === 'approved') return r;
      const chain = r.approvalChainId === null ? undefined : await approvalChainRepo.findById(db, r.approvalChainId);
      if (chain === undefined || chain.status === 'pending') return undefined;
      const request = { organisationId: r.organisationId, membershipId: r.requestedBy };
      if (chain.status === 'approved') {
        const approvers = (await approvalStepRepo.listByChain(db, chain.id)).flatMap((s) => (s.approverMembershipId === null ? [] : [s.approverMembershipId]));
        const updated = (await purgeRequestRepo.update(db, r.id, { status: 'approved', decidedAt: new Date(deps.now()).toISOString() }))!;
        await recordEvent(db, request, correlationId, {
          event: 'purge_approved', resource: { type: 'silo', id: r.siloId }, detail: { purge_id: r.id, approvers: approvers.join(',') }, service: 'siloes-capture',
        });
        return updated;
      }
      await purgeRequestRepo.update(db, r.id, { status: 'rejected', decidedAt: new Date(deps.now()).toISOString() });
      await recordEvent(db, request, correlationId, {
        event: 'purge_rejected', resource: { type: 'silo', id: r.siloId }, detail: { purge_id: r.id, chain: chain.status }, service: 'siloes-capture',
      });
      return undefined;
    });
    if (next !== undefined) {
      await runPurge(deps, next.organisationId, next.id, correlationId).catch((error: unknown) => {
        deps.logger.failure('a purge failed', error, { event: 'siloes.purge_failed', organisationId: next.organisationId });
      });
      started += 1;
    }
  }
  return started;
}

type Counts = Record<string, number>;

/** Runs an approved purge once: claims it, drains, deletes everywhere, and leaves its receipt. */
export async function runPurge(deps: PurgeDeps, organisationId: string, purgeId: string, correlationId: string): Promise<void> {
  const pool = deps.databases.pool('control');
  const claimed = await inTransaction(pool, { organisationId }, async (db) => {
    const r = await purgeRequestRepo.findById(db, purgeId);
    if (r === undefined || r.status !== 'approved') return undefined;
    return (await purgeRequestRepo.update(db, r.id, { status: 'running' }))!;
  });
  if (claimed === undefined) return;
  const request: RequestContext = { organisationId, membershipId: claimed.requestedBy };
  const ctx: Context = { request, correlationId };
  const t: Target = { scope: claimed.scope, objectTypeId: claimed.objectTypeId ?? undefined, fileId: claimed.siloFileId ?? undefined, objectRef: claimed.objectRef ?? undefined };
  let stage = 'prepare';
  try {
    const { silo, siloes, impact } = await inTransaction(pool, request, async (db) => {
      const silo = await loadSilo(db, claimed.siloId);
      const siloes = await reached(db, silo, t);
      // A whole-Silo wipe stops new captures and imports first.
      if (t.scope === 'silo') await siloRepo.update(db, silo.id, { status: 'purging' });
      return { silo, siloes, impact: await impactOf(db, siloes, t) };
    });
    // A Silo answering as a source stops answering before its rows go (66.5).
    if (t.scope === 'silo' && silo.sourceConnectionId !== null) {
      await deps.services.call(retireSiloSource, { params: { siloId: silo.id }, body: { move: 'halt' } }, { request, correlationId });
    }

    // (1) The queue first: what is in flight is still the customer's data.
    stage = 'drain';
    let drained = 0;
    // Every Silo the queue feeds: Capture, and a Warehouse's or an Object Index's change-stream observations (69.4, 69.15).
    for (const s of siloes.filter((x) => x.kind === 'capture' || x.kind === 'warehouse' || x.kind === 'object_index')) {
      drained += (await drainSilo(deps, organisationId, s.id, correlationId)).observations;
    }
    await inTransaction(pool, request, (db) => recordEvent(db, request, correlationId, {
      event: 'capture_queue_drained', resource: { type: 'silo', id: silo.id }, detail: { purge_id: purgeId, observations: drained }, service: 'siloes-capture',
    }));

    // (3) Every store the scope touches.
    const removed: Record<string, Counts> = {};
    const add = (store: string, counts: Counts) => {
      const into = removed[store] ?? (removed[store] = {});
      for (const [k, v] of Object.entries(counts)) into[k] = (into[k] ?? 0) + v;
    };
    for (const s of siloes) {
      stage = `wipe:${s.kind}`;
      // A wipe only deletes, so running it again is safe (what went counts nothing the second time):
      // a store briefly unreachable is tried again before the purge is failed.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await wipe(deps, ctx, s, t, add);
          break;
        } catch (error) {
          if (!isAppError(error) || !error.retryable || attempt >= WIPE_ATTEMPTS) throw error;
          await sleep(WIPE_RETRY_MS * attempt);
        }
      }
    }

    // (4) The receipt, and the Silo disabled for a whole-Silo wipe.
    stage = 'receipt';
    const counts = {
      rows: Object.values(removed).reduce((sum, c) => sum + (c['rows'] ?? 0) + (c['transitions'] ?? 0) + (c['baselines'] ?? 0) + (c['extractions'] ?? 0)
        + (c['entries'] ?? 0) + (c['ledger'] ?? 0), 0),
      files: removed['gcs']?.['files'] ?? 0,
      bytes: removed['gcs']?.['bytes'] ?? 0,
    };
    const completedAt = new Date(deps.now()).toISOString();
    // The Silo files this wipe removed, for the Files entries kept as them (41.5).
    const removedFiles = t.scope === 'file' ? [t.fileId!] : t.scope !== 'silo' ? []
      : await inTransaction(pool, request, async (db) => (await siloFileRepo.listForSilo(db, silo.id)).map((f) => f.id), { readOnly: true });
    let receiptId = '';
    await inTransaction(pool, request, async (db) => {
      if (t.scope === 'silo') {
        await siloObjectTypeRepo.endAll(db, silo.id, completedAt);
        await siloRepo.update(db, silo.id, { status: 'disabled', disabledAt: completedAt });
      }
      const receipt = await purgeReceiptRepo.insert(db, {
        id: uuidv7(), organisationId, purgeRequestId: purgeId, siloId: silo.id, scope: t.scope, objectTypeId: t.objectTypeId ?? null,
        siloFileId: t.fileId ?? null, objectRef: t.objectRef ?? null, removed, counts, impact, completedAt,
      });
      receiptId = receipt.id;
      await purgeRequestRepo.update(db, purgeId, { status: 'completed', completedAt });
      // The purge ledger (8.2; D251): kept outside this database, so a restore wipes again what came back.
      await outboxRepo.recordPurge(db, { organisationId, correlationId, entry: {
        kind: 'silo_wipe', siloId: silo.id, purgeId, scope: t.scope,
        ...(t.objectTypeId === undefined ? {} : { objectTypeId: t.objectTypeId }), ...(t.fileId === undefined ? {} : { siloFileId: t.fileId }),
        ...(t.objectRef === undefined ? {} : { objectRef: t.objectRef }),
      } });
      // Read first by a reviewer: the evidence a deletion request was honoured.
      await recordEvent(db, request, correlationId, {
        event: 'purge_completed', resource: { type: 'silo', id: silo.id },
        detail: { purge_id: purgeId, receipt_id: receipt.id, scope: t.scope, siloes: siloes.length, rows: counts.rows, files: counts.files }, service: 'siloes-capture',
      });
    });
    // The Silo is disabled: its source connection is revoked.
    if (t.scope === 'silo' && silo.sourceConnectionId !== null) {
      await deps.services.call(retireSiloSource, { params: { siloId: silo.id }, body: { move: 'revoke' } }, { request, correlationId });
    }
    // Files entries kept as the removed files go too, with this receipt as theirs. The wipe is
    // done whatever Files answers: an entry whose file is gone can no longer be opened.
    for (let i = 0; i < removedFiles.length; i += 10_000) {
      await deps.services.call(recordUploadsPurged, {
        body: { siloFileIds: removedFiles.slice(i, i + 10_000), purgeReceiptId: receiptId, requestedBy: claimed.requestedBy },
      }, { request, correlationId }).catch((error: unknown) => {
        deps.logger.failure('the Files entries of purged uploads could not be marked deleted', error, {
          event: 'siloes.files_entries_unmarked', organisationId, resourceId: purgeId,
        });
      });
    }
  } catch (error) {
    const code = isAppError(error) ? error.code : 'siloes.purge_failed';
    await inTransaction(pool, request, async (db) => {
      await purgeRequestRepo.update(db, purgeId, { status: 'failed', failureStage: `${stage}:${code}`.slice(0, 200) });
      await recordEvent(db, request, correlationId, {
        event: 'purge_failed', resource: { type: 'silo', id: claimed.siloId }, detail: { purge_id: purgeId, stage, code }, service: 'siloes-capture',
      });
    });
    throw error;
  }
}

/** Deletes one Silo's share of a wipe from its stores, counting what went. */
async function wipe(deps: PurgeDeps, ctx: Context, silo: Silo, t: Target, add: (store: string, counts: Counts) => void): Promise<void> {
  const pool = deps.databases.pool('control');
  const organisationId = silo.organisationId;
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  switch (silo.kind) {
    case 'capture': {
      const type = t.scope === 'silo' ? null : (t.objectTypeId ?? null);
      const ref = t.scope === 'entity' ? (t.objectRef ?? null) : null;
      const { ledger, ...captured } = await inTransaction(pool, ctx.request, (db) => transitionRepo.purge(db, organisationId, silo.id, type, ref));
      // The whole Silo: the Action ledger copy it held went too (D205); receipts remain the record.
      add('postgres', ledger > 0 ? { ...captured, ledger } : captured);
      return;
    }
    case 'import': {
      if (t.scope === 'concept') {
        // An imported object mapped to the type through the Silo's source connection (66.5, 68.5): its rows go with the concept.
        if (silo.sourceConnectionId === null) return;
        const manifest = await deps.services.call(getManifest, { query: {} }, call);
        const objects = [...new Set((manifest.objectTypes.find((x) => x.id === t.objectTypeId)?.contributingObjects ?? [])
          .filter((c) => c.connectionId === silo.sourceConnectionId).map((c) => c.sourceObject))];
        for (const object of objects) {
          const out = await deps.services.call(purgeImportObject, { body: { siloId: silo.id, object } }, call);
          add('bigquery', { rows: out.rowsDeleted, tables: out.dropped ? 1 : 0 });
          add('postgres', { extractions: await inTransaction(pool, ctx.request, (db) => siloExtractionRepo.purge(db, organisationId, silo.id, null, object)) });
        }
        return;
      }
      if (t.scope === 'object') {
        const out = await deps.services.call(purgeImportObject, { body: { siloId: silo.id, object: t.objectRef! } }, call);
        add('bigquery', { rows: out.rowsDeleted, tables: out.dropped ? 1 : 0 });
        add('postgres', { extractions: await inTransaction(pool, ctx.request, (db) => siloExtractionRepo.purge(db, organisationId, silo.id, null, t.objectRef!)) });
        return;
      }
      const files = await inTransaction(pool, ctx.request, async (db) => (t.scope === 'file'
        ? [(await siloFileRepo.findById(db, t.fileId!))!] : await siloFileRepo.listForSilo(db, silo.id)).filter((f) => f.status !== 'purged'), { readOnly: true });
      if (t.scope === 'file') {
        for (const f of files) {
          const out = await deps.services.call(purgeImportFile, { params: { fileId: f.id }, body: { siloId: silo.id, receivedAt: f.receivedAt } }, call);
          add('bigquery', { rows: out.rowsDeleted });
        }
      } else {
        const out = await deps.services.call(dropImportDataset, { body: { siloId: silo.id } }, call);
        add('bigquery', { datasets: out.dropped ? 1 : 0 });
      }
      // The file itself goes, not only its rows (70.2).
      for (const f of files) {
        if (deps.store === undefined) throw new AppError('configuration', 'purging files needs object storage', { code: 'config.siloes_storage' });
        await deps.store.purge('siloes', f.objectStoreKey as ObjectKey);
        add('gcs', { files: 1, bytes: Number(f.sizeBytes) });
      }
      const spatial = await inTransaction(pool, ctx.request, async (db) => {
        add('postgres', { extractions: await siloExtractionRepo.purge(db, organisationId, silo.id, t.scope === 'file' ? t.fileId! : null, null) });
        // Plans and models registered from these files go with them; their rows stay as the record (66.4; D208).
        const who = { organisationId, request: ctx.request, membershipId: ctx.request.membershipId, servicePrincipalId: ctx.request.servicePrincipalId };
        const reached = await purgeSpatialForFiles(db, who, ctx.correlationId, files.map((f) => f.id));
        if (reached.plans + reached.models > 0) add('postgres', { spatial_plans: reached.plans, asset_models: reached.models });
        const at = new Date(deps.now()).toISOString();
        for (const f of files) await siloFileRepo.update(db, f.id, { status: 'purged', purgedAt: at });
        if (t.scope === 'silo') for (const s of await siloSourceRepo.listForSilo(db, silo.id)) if (s.disabledAt === null) await siloSourceRepo.update(db, s.id, { disabledAt: at });
        await recordEvent(db, ctx.request, ctx.correlationId, {
          event: 'silo_import_purged', resource: { type: 'silo', id: silo.id }, detail: { scope: t.scope, files: files.length }, service: 'siloes-capture',
        });
        return reached;
      });
      // A model's checked copy, kept beside its file.
      for (const key of spatial.served) await deps.store!.purge('siloes', key as ObjectKey);
      return;
    }
    case 'object_index': {
      const type = t.scope === 'silo' ? undefined : t.objectTypeId;
      const out = await deps.services.call(purgeObjectIndex, { params: { siloId: silo.id }, body: type === undefined ? {} : { objectTypeId: type } }, call);
      add('index', { entries: out.entries, definitions: out.definitions, datasets: out.dropped ? 1 : 0 });
      return;
    }
    case 'warehouse': {
      const project = await inTransaction(pool, ctx.request, (db) => warehouseProjectRepo.findByOrganisationId(db, organisationId), { readOnly: true });
      if (project === undefined || project.siloId !== silo.id) return;
      if (t.scope === 'silo') {
        const out = await deps.services.call(purgeWarehouse, { params: { warehouseId: project.id } }, call);
        add('warehouse', { tables: out.tables, projects: out.projectDeleted ? 1 : 0, grants: out.grantsRevoked });
        // The Silo copy of the Action ledger went with it; the control plane's receipts remain the record (48.4, 70).
        if (silo.actionLedgerEnabledAt !== null) {
          await inTransaction(pool, ctx.request, (db) => recordEvent(db, ctx.request, ctx.correlationId, {
            event: 'ledger_purged', resource: { type: 'silo', id: silo.id }, detail: { warehouse_id: project.id, receipts_kept: true }, service: 'siloes-capture',
          }));
        }
      } else {
        const out = await deps.services.call(purgeWarehouseType, { params: { warehouseId: project.id, objectTypeId: t.objectTypeId! } }, call);
        add('warehouse', { tables: out.tables, rows: out.rowsDeleted });
      }
      return;
    }
  }
}

/**
 * Replays Silo wipes from the purge ledger after a restore (spec 8.2, 12.5; D251): each entry's
 * target wiped again in every Silo it reaches, and a whole Silo disabled again, before the cell
 * opens to traffic. A wipe only deletes, so what the restore brought back goes and nothing else;
 * a Silo the restore does not hold is skipped. Receipts stay in the ledger itself.
 */
export async function replaySiloWipes(deps: PurgeDeps, entries: readonly StoredLedgerEntry[]): Promise<{ replayed: number; skipped: number }> {
  const pool = deps.databases.pool('control');
  let replayed = 0;
  let skipped = 0;
  for (const stored of entries) {
    const e = stored.entry;
    if (e.kind !== 'silo_wipe') { skipped += 1; continue; }
    const request: RequestContext = { organisationId: stored.organisationId };
    const ctx: Context = { request, correlationId: stored.correlationId };
    const t: Target = { scope: e.scope, objectTypeId: e.objectTypeId, fileId: e.siloFileId, objectRef: e.objectRef };
    const found = await inTransaction(pool, request, async (db) => {
      const silo = await siloRepo.findById(db, e.siloId);
      return silo === undefined ? undefined : { silo, siloes: await reached(db, silo, t) };
    }, { readOnly: true });
    if (found === undefined) { skipped += 1; continue; }
    for (const s of found.siloes) await wipe(deps, ctx, s, t, () => undefined);
    if (t.scope === 'silo') {
      await inTransaction(pool, request, async (db) => {
        await siloObjectTypeRepo.endAll(db, found.silo.id, stored.occurredAt);
        await siloRepo.update(db, found.silo.id, { status: 'disabled', disabledAt: found.silo.disabledAt ?? stored.occurredAt });
      });
    }
    replayed += 1;
  }
  return { replayed, skipped };
}
