// Heal proposals (spec 17.3 to 17.5; design: connect.heal_proposals). A proposal records a
// drift and what is done about it:
//
// - a halt (a change of meaning, a removed object, a type that cannot hold its values)
//   repairs nothing: it is recorded with disposition halted, as the connection halts;
// - a repair is a new manifest version. Proposing it is charged (repair_proposal, 2 tokens)
//   to the person who asked for the re-check; a scheduled re-check is never metered. The
//   repaired version is created not current, tested by a conformance run in the sandbox, and
//   applied to the connection only when the run passes: the connection moves to it and, when
//   the version repaired was the connector's current one, it becomes current. A rename and a
//   lost pushdown are applied so (auto_applied); a new field and a widened type wait for a
//   person holding connector.heal_review (or the owner), and are applied when accepted.
//
// A catalogue connector is repaired by a catalogue release or a private fork of it; forking
// is not built, so its repairs wait for review and accepting one is refused.
//
// The proposal's jsonb holds structure only: proposed_diff the changes and the drift (names,
// paths, types, operators) and the repaired version once created; sandbox_result the test's
// status, the charge and codes.

import { getConformanceRun, startConformanceRun, type ConformanceRunView } from '../../contracts/conformance/conformance.contract.ts';
import {
  drift as driftSchema, manifestChange, type Disposition, type Drift, type HealProposalView, type ManifestChange,
} from '../../contracts/connector-maintenance/maintenance.contract.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import type { HealProposal } from '../../models/connect/healProposal.model.ts';
import { connectionRepo, connectorManifestRepo, connectorRepo, healProposalRepo } from '../../repos/connect/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, ContractViolation, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { validateManifest } from '../connect-registry/registry.service.ts';
import { protocolIssues } from '../connect-runtime/protocols/checks.protocol.ts';
import { demandOn, isPerson, loadConnection, recordMaintenanceEvent, type Context, type MaintenanceDeps } from './deps.service.ts';
import { nextVersion, repairedDocument, type ProposalPlan } from './drift.service.ts';

/** Remove the cast at integration: 'applied' joins the disposition check (report: schema). */
const APPLIED: HealProposal['disposition'] = 'applied';

type ChargeState = HealProposalView['charge'];
type SandboxState = HealProposalView['sandbox'];

interface Diff { changes: ManifestChange[]; drift: Drift[]; candidateManifestId: string | null }
interface Result { status: SandboxState['status']; reason: string | null; charge: ChargeState }

const diffOf = (p: HealProposal): Diff => {
  const raw = (p.proposedDiff ?? {}) as { changes?: unknown[]; drift?: unknown[]; candidateManifestId?: unknown };
  return {
    changes: (raw.changes ?? []).flatMap((c) => { const r = manifestChange.safeParse(c); return r.success ? [r.data] : []; }),
    drift: (raw.drift ?? []).flatMap((d) => { const r = driftSchema.safeParse(d); return r.success ? [r.data] : []; }),
    candidateManifestId: typeof raw.candidateManifestId === 'string' ? raw.candidateManifestId : null,
  };
};
const resultOf = (p: HealProposal): Result => {
  const raw = (p.sandboxResult ?? {}) as { status?: SandboxState['status']; reason?: string | null; charge?: ChargeState };
  return { status: raw.status ?? 'not_run', reason: raw.reason ?? null, charge: raw.charge ?? 'not_metered' };
};

export function proposalView(p: HealProposal): HealProposalView {
  const diff = diffOf(p);
  const result = resultOf(p);
  return {
    id: p.id, connectionId: p.connectionId, fromManifestId: p.fromManifestId, changeKind: p.changeKind, changes: diff.changes, drift: diff.drift,
    disposition: p.disposition as Disposition, candidateManifestId: diff.candidateManifestId,
    sandbox: { status: result.status, conformanceRunId: p.conformanceRunId, reason: result.reason },
    appliedManifestId: p.appliedManifestId, charge: result.charge, reviewedBy: p.reviewedBy, reviewedAt: p.reviewedAt, createdAt: p.createdAt,
  };
}

/** The organisation's own request, with no person: the service acting on its own. */
export const asService = (ctx: Context): Context => ({ request: { organisationId: ctx.request.organisationId! }, correlationId: ctx.correlationId });

export function createHeals(deps: MaintenanceDeps) {
  const control = deps.databases.pool('control');

  async function update(ctx: Context, id: string, changes: Partial<{ diff: Diff; result: Result }> & Parameters<typeof healProposalRepo.update>[2])
    : Promise<HealProposal> {
    const { diff, result, ...rest } = changes;
    return inTransaction(control, ctx.request, async (db) => (await healProposalRepo.update(db, id, {
      ...rest,
      ...(diff === undefined ? {} : { proposedDiff: diff as never }),
      ...(result === undefined ? {} : { sandboxResult: result as never }),
    }))!);
  }

  async function load(ctx: Context, id: string): Promise<HealProposal> {
    const p = await inTransaction(control, ctx.request, (db) => healProposalRepo.findById(db, id), { readOnly: true });
    if (!p) throw new AppError('not_found', 'no such heal proposal', { code: 'heal.not_found' });
    return p;
  }

  /** Records a proposal. A halt is recorded halted; a repair waits, its charge pending. */
  async function propose(ctx: Context, connection: Connection, plan: ProposalPlan): Promise<HealProposal> {
    const id = uuidv7();
    const result: Result = { status: 'not_run', reason: null, charge: plan.halt ? 'not_metered' : 'pending' };
    return inTransaction(control, ctx.request, async (db) => {
      const row = await healProposalRepo.insert(db, {
        id, organisationId: connection.organisationId, connectionId: connection.id, fromManifestId: connection.manifestId,
        changeKind: plan.changeKind, proposedDiff: { changes: plan.changes, drift: plan.drift, candidateManifestId: null } as never,
        sandboxResult: result as never, disposition: plan.halt ? 'halted' : 'awaiting_review',
      });
      await recordMaintenanceEvent(db, {
        organisationId: connection.organisationId, correlationId: ctx.correlationId, request: ctx.request,
        event: plan.halt ? 'heal_halted' : 'heal_proposed', resource: { type: 'heal_proposal', id },
        detail: { connection_id: connection.id, change_kind: plan.changeKind, changes: plan.changes.length, drift: plan.drift.length },
      });
      return row;
    });
  }

  /**
   * The repair's charge (spec 17.3, 73.1: 2 tokens). A person's request is charged to them;
   * the service on its own is a scheduled run, never metered (73.2). Keyed by the proposal,
   * so a retry or a later acceptance never charges twice.
   */
  async function chargeFor(ctx: Context, p: HealProposal): Promise<ChargeState> {
    const result = resultOf(p);
    if (result.charge === 'charged' || result.charge === 'never_metered') return result.charge;
    let state: ChargeState;
    try {
      const out = await deps.services.call(charge, {
        body: { operation: 'repair_proposal', correlationId: p.id, healProposalId: p.id, trigger: isPerson(ctx) ? 'authored' : 'cron_run' },
      }, { request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: `heal-${p.id}` });
      state = out.charged ? 'charged' : 'never_metered';
    } catch (error) {
      if (!isAppError(error) || error.category !== 'bounds') throw error;
      state = 'refused';
    }
    await update(ctx, p.id, { result: { ...resultOf(await load(ctx, p.id)), charge: state } });
    return state;
  }

  /** The repaired version, created not current. Refused for a catalogue connector (forking is not built). */
  async function candidate(ctx: Context, p: HealProposal, creatorMembershipId: string | undefined): Promise<string> {
    const diff = diffOf(p);
    if (diff.candidateManifestId !== null) return diff.candidateManifestId;
    const { connector, from, taken } = await inTransaction(control, ctx.request, async (db) => {
      const from = await connectorManifestRepo.findById(db, p.fromManifestId);
      const connector = from === undefined ? undefined : await connectorRepo.findById(db, from.connectorId);
      if (!from || !connector) throw new AppError('integrity', 'the version repaired is missing', { code: 'heal.manifest_missing' });
      return { connector, from, taken: new Set((await connectorManifestRepo.listForConnector(db, connector.id, 500)).map((m) => m.version)) };
    }, { readOnly: true });
    if (connector.organisationId === null) {
      throw new AppError('conflict', 'a catalogue connector is repaired by a catalogue release or a private fork of it; forking is not built yet', {
        code: 'heal.catalogue_connector',
      });
    }
    const document = repairedDocument(from.document as Record<string, unknown>, diff.changes, nextVersion(from.version, taken));
    let manifest;
    try {
      const validated = validateManifest(document);
      if (validated.expressionIssues.length > 0) throw new ContractViolation('an expression is refused', 'manifest.expression_invalid', validated.expressionIssues);
      manifest = validated.manifest;
      const issues = protocolIssues(manifest);
      if (issues.length > 0) throw new ContractViolation('the protocol engine refuses the repair', 'manifest.protocol_invalid', issues);
    } catch (error) {
      throw new AppError('validation', 'the repair does not make a valid manifest', {
        code: 'heal.repair_invalid', details: { reason: isAppError(error) ? error.code : 'invalid' },
      });
    }
    const canonical = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const id = uuidv7();
    try {
      await inTransaction(control, ctx.request, async (db) => {
        await connectorManifestRepo.insert(db, {
          id, organisationId: connector.organisationId, connectorId: connector.id, version: manifest.identity.version,
          document: canonical as never, documentHash: sha256(canonicalJsonBytes(canonical)), schemaVersion: manifest.schemaVersion,
          sourceRoute: connector.sourceRoute, parentVersionId: from.id, createdByMembershipId: creatorMembershipId ?? null,
          // Not current until applied: a version that fails its sandbox never becomes what new connections start on.
          supersededAt: new Date().toISOString(),
        });
        await healProposalRepo.update(db, p.id, { proposedDiff: { ...diff, candidateManifestId: id } as never });
        await recordMaintenanceEvent(db, {
          organisationId: p.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'connector_manifest_versioned',
          resource: { type: 'manifest', id }, detail: { connector_id: connector.id, heal_proposal_id: p.id, protocol: manifest.protocol.kind },
        });
      });
    } catch (error) {
      if (fromDatabaseError(error).category === 'conflict') {
        throw new AppError('conflict', 'another version was created at the same moment; try again', { code: 'heal.version_conflict', retryable: true });
      }
      throw error;
    }
    return id;
  }

  /** A conformance run on the repaired version, by the service; the answer once it ends. */
  async function sandbox(ctx: Context, p: HealProposal, manifestId: string): Promise<{ passed: boolean; runId: string | null; reason: string | null }> {
    const service = asService(ctx);
    let run: ConformanceRunView;
    try {
      run = await deps.services.call(startConformanceRun, {
        body: { connectionId: p.connectionId, trigger: 'self_heal', manifestId, classes: ['read', 'pagination', 'filter_pushdown', 'error'] },
      }, { ...service, idempotencyKey: `heal-sandbox-${p.id}-${manifestId}` });
    } catch (error) {
      return { passed: false, runId: null, reason: `start:${isAppError(error) ? error.code : 'error'}` };
    }
    await update(ctx, p.id, { conformanceRunId: run.id, result: { ...resultOf(await load(ctx, p.id)), status: 'running', reason: null } });
    const deadline = Date.now() + deps.runTimeoutMs;
    while (run.status === 'running' && Date.now() < deadline && !deps.signal.aborted) {
      await sleep(deps.pollMs, deps.signal).catch(() => undefined);
      if (!deps.signal.aborted) run = await deps.services.call(getConformanceRun, { params: { runId: run.id } }, service);
    }
    if (deps.signal.aborted) return { passed: false, runId: run.id, reason: 'shutdown' };
    if (run.status === 'running') return { passed: false, runId: run.id, reason: 'timeout' };
    if (run.status === 'abandoned') return { passed: false, runId: run.id, reason: 'abandoned' };
    return run.gate.verified ? { passed: true, runId: run.id, reason: null }
      : { passed: false, runId: run.id, reason: `failed:${run.gate.failedClasses.join(',') || 'read'}` };
  }

  /** The connection moves to the repaired version, if it still runs the version repaired. */
  async function apply(ctx: Context, p: HealProposal, manifestId: string, runId: string, disposition: HealProposal['disposition']): Promise<boolean> {
    return inTransaction(control, ctx.request, async (db) => {
      const locked = (await healProposalRepo.findForUpdate(db, p.id))!;
      if (locked.disposition !== 'awaiting_review') return false;
      const moved = await connectionRepo.moveToManifest(db, p.connectionId, p.fromManifestId, manifestId);
      if (!moved) {
        await healProposalRepo.update(db, p.id, { sandboxResult: { ...resultOf(locked), status: 'passed', reason: 'connection_moved_on' } as never });
        return false;
      }
      await connectorManifestRepo.makeCurrentAfter(db, moved.connectorId, p.fromManifestId, manifestId);
      await healProposalRepo.update(db, p.id, {
        disposition, appliedManifestId: manifestId, conformanceRunId: runId,
        sandboxResult: { ...resultOf(locked), status: 'passed', reason: null } as never,
      });
      await recordMaintenanceEvent(db, {
        organisationId: p.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'heal_applied',
        resource: { type: 'heal_proposal', id: p.id },
        detail: { connection_id: p.connectionId, change_kind: p.changeKind, manifest_id: manifestId, conformance_run_id: runId, reviewed: disposition === APPLIED },
      });
      return true;
    });
  }

  /**
   * Create the repaired version, test it, apply it if the test passes. The outcome is
   * recorded on the proposal; true when applied.
   */
  async function repair(ctx: Context, p: HealProposal, disposition: HealProposal['disposition'], creatorMembershipId: string | undefined)
    : Promise<{ applied: boolean; reason: string | null }> {
    let manifestId: string;
    try {
      manifestId = await candidate(ctx, p, creatorMembershipId);
    } catch (error) {
      const reason = isAppError(error) ? error.code : 'error';
      await update(ctx, p.id, { result: { ...resultOf(await load(ctx, p.id)), status: 'not_run', reason } });
      if (!isAppError(error) || error.category === 'internal') throw error;
      return { applied: false, reason };
    }
    const tested = await sandbox(ctx, await load(ctx, p.id), manifestId);
    if (!tested.passed) {
      await update(ctx, p.id, {
        ...(tested.runId === null ? {} : { conformanceRunId: tested.runId }),
        result: { ...resultOf(await load(ctx, p.id)), status: tested.runId === null ? 'not_run' : 'failed', reason: tested.reason },
      });
      return { applied: false, reason: tested.reason };
    }
    const applied = await apply(ctx, await load(ctx, p.id), manifestId, tested.runId!, disposition);
    return { applied, reason: applied ? null : 'connection_moved_on' };
  }

  return {
    propose, chargeFor, repair, load,

    /** Halts an active connection, naming the drift; the halt and its event in one transaction. */
    async halt(ctx: Context, connection: Connection, reason: string): Promise<boolean> {
      return inTransaction(control, ctx.request, async (db) => {
        const halted = await connectionRepo.haltForDrift(db, connection.id, reason.slice(0, 500));
        if (!halted) return false;
        await recordMaintenanceEvent(db, {
          organisationId: connection.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'connection_halted',
          resource: { type: 'connection', id: connection.id }, detail: { reason: reason.slice(0, 200), by: 'connector-maintenance' },
        });
        return true;
      });
    },

    async get(ctx: Context, proposalId: string): Promise<HealProposalView> {
      const p = await load(ctx, proposalId);
      await demandOn(deps, ctx, await loadConnection(deps, ctx, p.connectionId), ['connector.heal_review', 'connector.verify']);
      return proposalView(p);
    },

    async list(ctx: Context, filter: { connectionId?: string | undefined; disposition?: string | undefined; limit: number }): Promise<HealProposalView[]> {
      if (filter.connectionId !== undefined) {
        await demandOn(deps, ctx, await loadConnection(deps, ctx, filter.connectionId), ['connector.heal_review', 'connector.verify']);
      }
      const rows = await inTransaction(control, ctx.request, (db) => healProposalRepo.list(db, filter), { readOnly: true });
      if (filter.connectionId !== undefined) return rows.map(proposalView);
      // Across connections: only those the reader may review.
      const out: HealProposalView[] = [];
      const allowed = new Map<string, boolean>();
      for (const row of rows) {
        if (!allowed.has(row.connectionId)) {
          const connection = await loadConnection(deps, ctx, row.connectionId);
          allowed.set(row.connectionId, await demandOn(deps, ctx, connection, ['connector.heal_review', 'connector.verify']).then(() => true, () => false));
        }
        if (allowed.get(row.connectionId)) out.push(proposalView(row));
      }
      return out;
    },

    /**
     * A person's decision on a proposal awaiting review. Rejecting closes it. Accepting
     * charges the repair if it was not charged when proposed, then creates, tests and applies
     * it in the background; the answer is the proposal as accepted.
     */
    async decide(ctx: Context, proposalId: string, decision: 'accept' | 'reject', background: (work: Promise<unknown>) => void)
      : Promise<HealProposalView> {
      if (!isPerson(ctx)) throw new AppError('forbidden', 'a heal proposal is decided by a person', { code: 'heal.person_required' });
      const p = await load(ctx, proposalId);
      const connection = await loadConnection(deps, ctx, p.connectionId);
      await demandOn(deps, ctx, connection, ['connector.heal_review']);
      if (p.disposition !== 'awaiting_review') {
        throw new AppError('conflict', `the proposal is ${p.disposition}; only one awaiting review is decided`, { code: 'heal.not_awaiting_review' });
      }
      if (p.reviewedBy !== null) throw new AppError('conflict', 'the proposal was accepted and is being tested', { code: 'heal.already_accepted' });
      const now = new Date().toISOString();
      if (decision === 'reject') {
        return proposalView(await inTransaction(control, ctx.request, async (db) => {
          const locked = (await healProposalRepo.findForUpdate(db, p.id))!;
          if (locked.disposition !== 'awaiting_review' || locked.reviewedBy !== null) {
            throw new AppError('conflict', 'the proposal was decided meanwhile', { code: 'heal.not_awaiting_review' });
          }
          const row = (await healProposalRepo.update(db, p.id, { disposition: 'rejected', reviewedBy: ctx.request.membershipId!, reviewedAt: now }))!;
          await recordMaintenanceEvent(db, {
            organisationId: p.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'heal_rejected',
            resource: { type: 'heal_proposal', id: p.id }, detail: { connection_id: p.connectionId, change_kind: p.changeKind },
          });
          return row;
        }));
      }
      if (diffOf(p).changes.length === 0) throw new AppError('conflict', 'this proposal repairs nothing', { code: 'heal.nothing_to_apply' });
      if (connection.status === 'revoked') throw new AppError('conflict', 'the connection is revoked', { code: 'connection.revoked' });
      const charged = await chargeFor(ctx, p);
      if (charged === 'refused') {
        throw new AppError('bounds', 'your tokens do not cover this repair proposal', { code: 'heal.charge_refused', details: { bound: 'tokens' } });
      }
      const accepted = await inTransaction(control, ctx.request, async (db) => {
        const locked = (await healProposalRepo.findForUpdate(db, p.id))!;
        if (locked.disposition !== 'awaiting_review' || locked.reviewedBy !== null) {
          throw new AppError('conflict', 'the proposal was decided meanwhile', { code: 'heal.not_awaiting_review' });
        }
        return (await healProposalRepo.update(db, p.id, { reviewedBy: ctx.request.membershipId!, reviewedAt: now }))!;
      });
      background((async () => {
        const outcome = await repair(ctx, accepted, APPLIED, ctx.request.membershipId);
        if (!outcome.applied) {
          // Back in the review queue, with the sandbox's reason: a person decides again.
          await update(ctx, p.id, { reviewedBy: null, reviewedAt: null });
          deps.logger.info('an accepted repair was not applied', { event: 'maintenance.repair_not_applied', resourceId: p.id, outcome: outcome.reason ?? 'unknown' });
        }
      })().catch((error: unknown) => deps.logger.failure('applying an accepted repair failed', error, { event: 'maintenance.repair_failed', resourceId: p.id })));
      return proposalView(accepted);
    },
  };
}

export type Heals = ReturnType<typeof createHeals>;
